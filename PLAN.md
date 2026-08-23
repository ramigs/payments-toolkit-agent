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
- This logging is what step 5's eval script reads to check agent
  behavior, and it's also the first piece of the "production-minded, not
  demo-ware" case discussed for the portfolio framing

**Implementation note:** went with a dedicated local file
(`logs/agent.log`, gitignored) rather than stderr, so the eval script in
step 5 reads a clean stream instead of one interleaved with the MCP
child process's own stderr logs. This is a deliberate departure from
the usual "log to stdout/stderr, let the environment handle routing"
convention (which is what `payments-toolkit-mcp`'s own logger correctly
does) — it only makes sense while this agent is a one-shot CLI script
with a colocated reader. See the matching fast-follow below.

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
- `eval/run-eval.ts`: runs each scenario through the agent, checks actual
  tool-call trace and response against the expected outcome, prints a
  pass/fail summary
- Run this manually for now (`pnpm run eval`); wiring it into CI is a
  fast-follow, not required for the first working version

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
  "app emits a stream, the environment routes it" practice, with the
  eval script (or whatever observability tooling exists by then)
  capturing that stream directly instead of reading a file

## Definition of done for this iteration

- `pnpm start "<question>"` runs a full agent turn against the real MCP
  server and prints a clear tool-call trace + final answer
- `pnpm run eval` runs the scenario set and reports pass/fail per
  scenario
- README explains setup and scope clearly enough that a stranger (or a
  future you) could pick this up cold
