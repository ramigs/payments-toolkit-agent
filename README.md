# payments-toolkit-agent

An agent backend, built with [Google ADK](https://google.github.io/adk-docs/),
that connects to [payments-toolkit-mcp](https://github.com/ramigs/payments-toolkit-mcp)
as an MCP server and exposes it as a conversational interface. It's a
companion project — the MCP server stays untouched; this repo just adds an
agent layer on top of it. See [PLAN.md](./PLAN.md) for the full step-by-step
walkthrough, including the reasoning behind each design decision.

This is step 1 of 2: a local, CLI-only backend that proves out the full
loop (user request → agent reasoning → MCP tool call → tool result → agent
response) with visibility into each step. Step 2 (a separate project) adds
an AG-UI-based frontend on top of this backend.

## Prerequisites

- Node.js 18+ (project developed against v24)
- [pnpm](https://pnpm.io)
- [`payments-toolkit-mcp`](https://github.com/ramigs/payments-toolkit-mcp)
  built locally (`pnpm run build` in that repo)
- A Gemini API key (from [Google AI Studio](https://aistudio.google.com/app/apikey))

## Setup

```bash
pnpm install
cp .env.example .env
# then fill in GEMINI_API_KEY and MCP_SERVER_PATH in .env
```

`MCP_SERVER_PATH` is the absolute path to the built MCP server's entry
point, e.g. `/path/to/payments-toolkit-mcp/dist/index.js`.

## Usage

Run a single agent turn against the real MCP server:

```bash
pnpm start "Is DE89370400440532013000 a valid IBAN?"
```

This is intentionally not a REPL — one request in, one full trace out. Each
run prints, in order:

1. The discovered MCP tools/resources/prompts (a boot-time sanity check)
2. Each tool call the agent makes, with arguments
3. Each tool's raw result
4. The agent's final natural-language response

The agent is scoped narrowly to payment-detail validation (card numbers,
card types, IBANs) via its system prompt (`src/agent.ts`) and declines
anything else.

### Logging

Every tool call is also logged as structured JSON to `logs/agent.log`
(gitignored), with sensitive arguments (card numbers, IBANs) masked to
their last 4 characters. Tail it in a readable form with:

```bash
tail -f logs/agent.log | pnpm exec pino-pretty
```

This log is for human/audit observability — the eval suite below does
**not** read it, since the masking would hide argument details some
scenarios need to check (see `eval/run-eval.ts`).

## Eval suite

`payments-toolkit-agent`'s behavior — which tool it picks, what arguments
it passes, how faithfully it relays a result, whether it declines or asks
for clarification appropriately — isn't deterministic, so it's checked with
a scenario-based eval rather than unit tests. See `eval/scenarios.ts` for
the 12 scenarios and `eval/JOURNAL.md` for a running log of what this suite
has actually found (and fixed) so far.

Run the full suite:

```bash
pnpm run eval
```

Each scenario is graded independently on three axes — which tool(s) were
called, whether the arguments were constructed correctly, and whether the
final response is accurate — so a wrong-tool failure and a
mis-relayed-result failure are distinguishable at a glance instead of
collapsing into one pass/fail mark.

Run a subset by scenario id, useful when checking a single fix without
re-running (and re-paying for) the whole suite:

```bash
pnpm run eval card-luhn-only ambiguous-clarify
```

Each scenario runs once per invocation — a single sample of the model's
behavior, not a guaranteed-repeatable result. Run the suite more than once
if a failure looks surprising before treating it as a real finding.

## Unit tests

```bash
pnpm test              # run the full suite once
pnpm run test:watch    # re-run on file changes
pnpm run test:coverage # run once and print a coverage report
```

These cover the deterministic logic in `src/` (event-to-CLI-output mapping,
argument masking, prompt parsing) — a different, narrower concern than the
eval suite above, which checks the agent's own decisions.

## Project structure

```
src/
  index.ts       # entry point: single-turn CLI runner
  agent.ts       # agent definition: system prompt, MCP server registration
  trace.ts       # maps one ADK structured event to CLI output / log input
  logging.ts     # structured, redacted tool-call logging (logs/agent.log)
  prompt.ts      # reads the user's prompt from argv or stdin
eval/
  scenarios.ts   # scenario-based eval set — expectations per tool/args/response
  run-eval.ts    # eval runner: builds the agent, runs each scenario, grades it
  JOURNAL.md     # running log of eval findings and fixes
tests/unit/       # unit tests for src/, mirrored 1:1
```

## Scope

This is a deliberate first iteration, not an unfinished one:

- No frontend yet — backend/CLI only, verified via terminal output and logs
- No new MCP tools — reuses the three existing ones as-is
- No production deployment — local-first, spawns the MCP server as a child
  process over stdio
- No auth/guardrail system yet

See the "Fast-follows" section of [PLAN.md](./PLAN.md) for what's tracked
for later (HTTP transport, guardrails, AG-UI streaming, a frontend, and
revisiting the logging destination once this becomes a long-lived service).
