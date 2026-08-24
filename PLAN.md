# PLAN: payments-toolkit-agent

A minimal agent backend, built with the Claude Agent SDK, that connects to
the existing [payments-toolkit-mcp](https://github.com/ramigs/payments-toolkit-mcp)
server and exposes it as a conversational interface. This is a companion
project — the MCP server stays untouched; this repo just adds an agent
layer on top of it.

## Goal

Prove out the full loop: user request → agent reasoning → MCP tool call →
tool result → agent response — with visibility into each step, running
locally first, over HTTP later. This is step 1 of 2; step 2 (a separate
project) will add an AG-UI-based frontend on top of this backend.

## Non-goals (for this iteration)

- No frontend yet — this phase is backend/CLI only, verified via terminal
  output and logs.
- No new MCP tools — reuse the three existing ones (`validate_card_number`,
  `detect_card_type`, `validate_iban`) as-is.
- No production deployment — local-first, Node process.
- No auth/guardrail system yet — flagged as a fast-follow, not in scope
  for the minimal version.

## Prerequisites

- Node.js 18+ (matching the MCP server's requirement)
- pnpm
- `payments-toolkit-mcp` built and runnable locally (`pnpm run build` in
  that repo)
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- `@anthropic-ai/claude-agent-sdk` (TypeScript)

## Project structure

```
payments-toolkit-agent/
  src/
    index.ts              # entry point: runs a single-turn or REPL-style agent session
    agent.ts              # agent definition: system prompt, MCP server registration
    logging.ts            # structured logging for tool calls (see Step 4)
  eval/
    scenarios.ts           # scenario-based eval set (see Step 5)
    run-eval.ts             # eval runner script
  .env.example
  package.json
  tsconfig.json
  README.md
```

## Steps

### 1. Scaffold the project

- `pnpm init`, add TypeScript, `@anthropic-ai/claude-agent-sdk`, `dotenv`
- Copy the `.nvmrc` convention from `payments-toolkit-mcp` for consistency
- Add `ANTHROPIC_API_KEY` via `.env` (gitignored), with a `.env.example`
  committed

### 2. Register the MCP server with the agent

- Point the Claude Agent SDK at `payments-toolkit-mcp` as an MCP server
  connection — start with **stdio transport**, spawning the built MCP
  server as a child process (`node /path/to/payments-toolkit-mcp/dist/index.js`),
  matching the same connection method already documented for Claude Code
  in the MCP repo's README
- Confirm on startup that the agent discovers all three tools plus the
  `card_networks` resource — log the discovered tool list once at boot as
  a sanity check
- Write the agent's system prompt narrowly: it should only reason about
  payment-detail validation (card numbers, card types, IBANs) and should
  explicitly decline unrelated requests — keeps the demo focused and
  avoids scope creep into general-purpose assistant behavior

### 3. Build a minimal single-turn runner

- `src/index.ts` accepts a single user message via CLI arg or stdin (e.g.
  `pnpm start "Is DE89370400440532013000 a valid IBAN?"`)
- Runs one agent turn, prints:
  - the tool(s) the agent chose to call, with arguments
  - the raw tool result(s)
  - the agent's final natural-language response
- This is intentionally not a full REPL yet — one request in, one full
  trace out, so each run is easy to eyeball and easy to feed into the
  eval script later

### 4. Add structured logging (carries over the "no console.log on stdout"

discipline from the MCP server)

- Log every tool call the agent makes: tool name, arguments (mask/redact
  full card numbers and IBANs, log only last 4 digits or a hash), and the
  tool's raw result
- Log to `stderr` or a local file, not stdout, to keep the same hygiene
  as the MCP server's transport rules
- This logging is the audit/observability trail for a human (or a future
  log-shipping pipeline) to inspect after the fact — it's masked/redacted
  by design, and it's also the first piece of the "production-minded, not
  demo-ware" case discussed for the portfolio framing. It is **not** what
  step 5's eval script reads: the eval runner captures the tool-call
  trace in-process (see step 5), since the masking here would hide
  exactly the argument detail (e.g. whether dashes were stripped from a
  card number) that some eval scenarios need to check.

**Implementation note:** went with a dedicated local file
(`logs/agent.log`, gitignored) rather than stderr, so a human tailing it
(`tail -f logs/agent.log | pnpm exec pino-pretty`) sees a clean stream
instead of one interleaved with the MCP child process's own stderr
logs. This is a deliberate departure from the usual "log to
stdout/stderr, let the environment handle routing" convention (which is
what `payments-toolkit-mcp`'s own logger correctly does) — it only
makes sense while this agent is a one-shot CLI script with a colocated
reader. See the matching fast-follow below.

### 5. Build a small scenario-based eval set

This is agent-level eval, distinct from the MCP server's own unit tests —
it tests tool _selection_ and _usage_, not tool correctness.

- `eval/scenarios.ts`: 8-12 representative prompts, each with an expected
  outcome, e.g.:
  - "Check this card: 4111111111111111" → expects `validate_card_number`
    - `detect_card_type` called, correct network identified
  - "Is DE89370400440532013000 valid?" → expects `validate_iban` called,
    correct verdict
  - "What's the weather today?" → expects **no tool call**, and a polite
    decline consistent with the narrow system prompt
  - A deliberately malformed/ambiguous input → expects the agent to ask
    for clarification rather than guessing
  - A case where the underlying tool returns invalid → expects the agent
    to accurately relay "invalid," not soften or override it
  - Expectations are graded on independent axes per scenario rather than
    a single pass/fail — `expectedTools`, `expectedArgs` (checked against
    the real in-process args, e.g. verifying dashes were stripped before
    the call), and `expectedResponse` (a heuristic check on the final
    text, e.g. matches/doesn't-match a regex for "invalid" vs "valid").
    Not every scenario needs all three (the weather scenario has no
    `expectedArgs`, since it expects no call at all). Kept intentionally
    simple for now — three typed fields checked independently, no
    weighting/scoring system — but shaped so a 4th axis or richer checks
    can be added later without a rewrite.
  - Response-text grading uses heuristics (substring/regex), not an
    LLM-as-judge — the scenario set is small and deliberately clear-cut
    (a hard invalid/valid, an unambiguous decline, an unambiguous
    clarifying question), so heuristics should hold up. If phrasing
    variance makes them flaky in practice, upgrading just the
    `expectedResponse` axis to an LLM judge is a fast-follow, not a
    redesign.
- `eval/run-eval.ts`: for each scenario, builds the agent and runs it
  in-process (same `buildAgent`/`runner.runEphemeral`/`describeEvent`
  pattern as `src/index.ts`), capturing the structured tool-call trace
  and final response directly from the event stream — not by reading
  `logs/agent.log`, since that log's argument masking would hide
  argument-construction details some scenarios need to check. Checks the
  captured trace and response against each scenario's expected outcome
  per axis (tools / args / response) and prints a per-axis pass/fail
  summary, so a wrong-tool failure and a mis-relayed-result failure are
  distinguishable at a glance instead of collapsing into one red mark
- Run this manually for now (`pnpm run eval`); wiring it into CI is a
  fast-follow, not required for the first working version
- Each scenario runs once per eval invocation (a single sample from the
  model's behavior, not a guaranteed-repeatable result). Kept simple
  deliberately — repeated trials per scenario with a pass-rate instead
  of a boolean is the fast-follow if flakiness shows up in practice or
  once this is wired into CI, not something to build ahead of need

### 6. README pass

- Document setup, how to run a single query, how to run the eval suite
- Note explicitly that this is a companion project to
  `payments-toolkit-mcp` and link back to it
- Note the intentional scope boundaries (no frontend, no guardrails yet)
  so it reads as a deliberate first iteration, not an unfinished attempt

## Fast-follows (explicitly out of scope for this PLAN, tracked for later)

- HTTP transport for the MCP connection (matching the MCP server's
  existing `start:http` mode), so the agent backend can run as a
  long-lived service rather than spawning a child process per session
- Basic guardrails: spend/scope limits, input redaction before logging,
  explicit refusal handling for out-of-scope requests
- AG-UI event streaming layer, so a frontend can show live tool-call
  progress instead of only a final CLI printout
- A Vue/Nuxt frontend (via TanStack AI's Vue client) consuming the AG-UI
  stream — the actual demoable, client-facing piece
- Revisit the agent's logging destination (`src/logging.ts`) once this
  backend becomes a long-lived HTTP service rather than a one-shot CLI —
  at that point it should switch from writing to `logs/agent.log` back
  to stdout/stderr, matching the MCP server's convention and the usual
  "app emits a stream, the environment routes it" practice (this is
  independent of the eval script, which captures its trace in-process
  and was never reading this log — see step 5)
- Eval hardening: repeated trials per scenario with a pass-rate instead
  of a single run/boolean (see step 5), and upgrading the response-text
  axis from heuristic checks to an LLM-as-judge if phrasing variance
  makes heuristics flaky in practice

## Definition of done for this iteration

- `pnpm start "<question>"` runs a full agent turn against the real MCP
  server and prints a clear tool-call trace + final answer
- `pnpm run eval` runs the scenario set and reports pass/fail per
  scenario
- README explains setup and scope clearly enough that a stranger (or a
  future you) could pick this up cold
