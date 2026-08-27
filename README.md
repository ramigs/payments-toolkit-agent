# payments-toolkit-agent

An agent backend, built with [Google ADK](https://google.github.io/adk-docs/),
that connects to [payments-toolkit-mcp](https://github.com/ramigs/payments-toolkit-mcp)
as an MCP server and exposes it as a conversational interface. It's a
companion project — the MCP server stays untouched; this repo just adds an
agent layer on top of it. See [PLAN.md](./PLAN.md) for the full step-by-step
walkthrough, including the reasoning behind each design decision.

This is step 1 of 2: a local backend (CLI and HTTP+SSE) that proves out the
full loop (user request → agent reasoning → MCP tool call → tool result →
agent response) with visibility into each step. Step 2
(`payments-toolkit-frontend`, a separate project) adds an AG-UI-based
frontend on top of this backend's HTTP endpoint.

## Prerequisites

- Node.js 20.3+ (for `AbortSignal.any`; project developed against v24,
  pinned via `.nvmrc`)
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

## HTTP server

Run the agent as a long-lived HTTP server instead of a one-shot CLI call:

```bash
pnpm run start:http
```

Listens on `PORT` (default `3001`) and exposes:

```
POST /chat
Content-Type: application/json

<an AG-UI RunAgentInput: { threadId, runId, messages, ... }>
```

The request body is a full [AG-UI](https://docs.ag-ui.com) `RunAgentInput`
(validated with `@ag-ui/core`'s `RunAgentInputSchema`); the prompt is taken
from the last `role: "user"` message. The response is a Server-Sent Events
stream of official AG-UI events — one full agent turn per request, no
conversation state kept between requests (the frontend project owns
session/thread identity if it needs multi-turn memory):

```
data: {"type":"RUN_STARTED","threadId":"...","runId":"..."}
data: {"type":"TOOL_CALL_START","toolCallId":"...","toolCallName":"validate_iban", ...}
data: {"type":"TOOL_CALL_ARGS","toolCallId":"...","delta":"{\"iban\":\"DE89...\"}"}
data: {"type":"TOOL_CALL_END","toolCallId":"..."}
data: {"type":"TOOL_CALL_RESULT","toolCallId":"...","content":"{...}"}
data: {"type":"TEXT_MESSAGE_START","messageId":"...","role":"assistant"}
data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"Yes, DE89... is a valid IBAN."}
data: {"type":"TEXT_MESSAGE_END","messageId":"..."}
data: {"type":"RUN_FINISHED","threadId":"...","runId":"..."}
```

A tool that advertises an [MCP Apps](https://github.com/modelcontextprotocol)
widget (currently `detect_card_type`) also emits a `CUSTOM` event with
`name: "ui-resource"` after its `TOOL_CALL_RESULT`, carrying the widget
resource for the frontend to render. On failure, a terminal
`{"type":"RUN_ERROR","message":"..."}` replaces `RUN_FINISHED`.

```
POST /chat/:runId/cancel
```

Cancels an in-flight turn: aborts the model request (and any in-flight MCP
tool call), then closes the stream with `RUN_ERROR` / `"cancelled"`.
Returns `202` if a run was aborted, `404` if none is in flight (already
finished, or unknown `runId`). Dropping the `/chat` connection cancels the
turn the same way — the endpoint just doesn't depend on the socket closing,
which a proxy can delay.

The tool-call audit log (`logs/agent.log`, same masking as the CLI) is
shared across all requests. The `@google/adk` MCP toolset opens a fresh
stdio child per tool call rather than holding one open; the one persistent
MCP client is `src/mcp-ui.ts`'s, used only to resolve widget resources.

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

These cover the deterministic logic in `src/` (event mapping, argument
masking, prompt parsing, and the `/chat` + cancel routes via a fake
runner) — a different, narrower concern than the eval suite above, which
checks the agent's own decisions.

## Project structure

```
src/
  index.ts       # entry point: single-turn CLI runner
  http.ts        # entry point: HTTP server — wires deps into createChatApp, serve()
  app.ts         # Hono app factory: POST /chat (AG-UI/SSE) + POST /chat/:runId/cancel
  agent.ts       # agent definition: system prompt, MCP server registration
  trace.ts       # maps one ADK structured event to an EventOutcome (CLI, eval, and /chat)
  ag-ui.ts       # translates EventOutcome into official AG-UI events
  mcp-ui.ts      # resolves MCP Apps `ui://` widget resources for /chat
  logging.ts     # structured, redacted tool-call logging (logs/agent.log)
  prompt.ts      # reads the user's prompt from argv or stdin (CLI only)
eval/
  scenarios.ts   # scenario-based eval set — expectations per tool/args/response
  run-eval.ts    # eval runner: builds the agent, runs each scenario, grades it
  JOURNAL.md     # running log of eval findings and fixes
tests/unit/       # unit tests for the deterministic logic in src/
```

## Scope

This is a deliberate first iteration, not an unfinished one:

- No frontend in this repo — backend only (CLI + HTTP/SSE), verified via
  terminal output, curl, and logs; the frontend is a separate project
  (`payments-toolkit-frontend`)
- No new MCP tools — reuses the three existing ones as-is
- No production deployment — local-first, spawns the MCP server as a child
  process over stdio
- No auth/guardrail system yet
- `/chat` emits the official AG-UI protocol events, translated from the ADK
  event stream by hand in `src/ag-ui.ts` (no TypeScript ADK↔AG-UI bridge
  exists — the published `@ag-ui/adk` is a client for a Python middleware)
- No multi-turn session state — each `/chat` request is a single, isolated
  agent turn

See the "Fast-follows" section of [PLAN.md](./PLAN.md) for what's tracked
for later (MCP-connection-over-HTTP transport, guardrails, multi-turn
session state, and revisiting the CLI's logging destination once it also
becomes a long-lived service).
