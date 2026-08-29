# PLAN: payments-toolkit-agent

A minimal agent backend, built with the Google ADK, that connects to
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

- No frontend yet — this phase is backend only (CLI + HTTP/SSE for a
  future frontend to consume), verified via terminal output, curl, and
  logs.
- No new MCP tools — reuse the three existing ones (`validate_card_number`,
  `detect_card_type`, `validate_iban`) as-is.
- No production deployment — local-first, Node process.
- No auth/guardrail system yet — flagged as a fast-follow, not in scope
  for the minimal version.

## Prerequisites

- Node.js 20.3+ (for `AbortSignal.any`, used by `/chat` cancellation — see
  Step 10); pinned to v24 via `.nvmrc`
- pnpm
- `payments-toolkit-mcp` built and runnable locally (`pnpm run build` in
  that repo)
- A Gemini API key (`GEMINI_API_KEY`)
- `@google/adk` (TypeScript)

## Project structure

```
payments-toolkit-agent/
  src/
    index.ts             # entry point: single-turn CLI agent run (argv or stdin)
    http.ts              # entry point: HTTP server — wires deps into createChatApp, serve() (see Steps 7, 10)
    app.ts               # Hono app factory: POST /chat (AG-UI/SSE) + POST /chat/:runId/cancel (see Steps 8, 10)
    agent.ts             # agent definition: system prompt, MCP server registration
    prompt.ts            # reads the CLI prompt from argv or stdin (index.ts only)
    trace.ts             # maps one ADK structured event to an EventOutcome — shared by all three runners
    ag-ui.ts             # EventOutcome → official AG-UI event translation (see Step 8)
    mcp-ui.ts            # resolves MCP Apps `ui://` widget resources for /chat (see Step 9)
    logging.ts           # structured, redacted tool-call logging to logs/agent.log (see Step 4)
  tests/unit/            # vitest suites for the deterministic logic in src/ (agent, prompt, trace, logging, app)
  eval/
    scenarios.ts         # scenario-based eval set (see Step 5)
    run-eval.ts           # eval runner script
    JOURNAL.md            # running log of eval findings and fixes
  .env.example
  package.json
  tsconfig.json
  README.md
```

## Steps

### 1. Scaffold the project

- `pnpm init`, add TypeScript, `@google/adk`, `dotenv`
- Copy the `.nvmrc` convention from `payments-toolkit-mcp` for consistency
- Add `GEMINI_API_KEY` via `.env` (gitignored), with a `.env.example`
  committed

**Implementation note:** started against `@anthropic-ai/claude-agent-sdk`,
then switched to `@google/adk` shortly after (an MCP-native choice, and
the one the AG-UI/frontend brainstorming in step 7 also builds on) — the
rest of this plan reflects the ADK version throughout.

### 2. Register the MCP server with the agent

- Point the Google ADK at `payments-toolkit-mcp` as an MCP server
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

### 7. Add an HTTP+SSE endpoint for the future frontend

This is the API layer the step-2 frontend project will actually talk to —
until now, this backend was only reachable via CLI. Decided ahead of time
(see the brainstorming doc that seeded this step):

- **Single-turn, not session-aware.** One `POST /chat` runs one agent turn
  and streams its events back — no conversation history kept between
  requests. Mirrors what `src/index.ts` already does, just over HTTP
  instead of argv/stdin. (Originally `runner.runEphemeral()`; Step 10
  replaced it with a hand-rolled `createSession()` → `runAsync()` →
  `deleteSession()` so an `AbortSignal` can be threaded through the turn.)
  Multi-turn session state (a session id, a history store) is real added
  complexity that the frontend project may not even need on day one —
  deferred until it's known to be needed, not built ahead of it.
- **(Superseded by Step 8.)** _This repo's own simple SSE event shapes for
  now, not the official AG-UI protocol schema._ `tool_call` /
  `tool_result` / `content` / `error` / `done` events, a near-direct reuse
  of `src/trace.ts`'s existing `describeEvent` mapping. AG-UI standardizes
  the event _shape_, not the
  transport (SSE/WebSocket/etc. are all valid AG-UI transports) — so
  "stream events over SSE" and "shape those events as AG-UI" are separable
  decisions. Adopting the official `ag-ui-protocol` ADK integration is
  deferred until the frontend project is actually being built and needs to
  consume them, rather than guessing at the right shape now with no
  consumer to validate against.
- **Hono** (`hono` + `@hono/node-server`) for the HTTP layer — lightweight,
  TypeScript-first, and has a built-in SSE streaming helper
  (`hono/streaming`), which suits a single small endpoint better than
  Express's more manual SSE plumbing (Express was the other candidate,
  for consistency with `payments-toolkit-mcp`'s own HTTP transport).

Implementation:

- The agent, MCP connection (child process), and ADK `InMemoryRunner` are
  built **once** at server startup and reused across every request —
  unlike the CLI, which builds fresh per invocation since it exits after
  one turn. `SIGINT`/`SIGTERM` close the MCP connection before exit.
- The `/chat` handler streams SSE events reusing the exact same
  `describeEvent`/`logToolCall`/`logToolResult` pipeline the CLI and eval
  runner already share — one source of truth for "what happened," now
  three consumers (CLI stdout, `logs/agent.log`, and this SSE stream).
- `PORT` env var, default `3001` (payments-toolkit-mcp's own
  `start:http` defaults to `3000`, so both can run at once unset).
- Verified end-to-end with a real request (`curl -N`): correct SSE
  framing, correct tool call, correct result, correct final answer, and a
  confirmed graceful shutdown on `SIGTERM`.

**Since superseded:** the request body moved from `{ "prompt": string }` to
an AG-UI `RunAgentInput` (Step 8), and the `/chat` + cancel route logic
moved out of `src/http.ts` into `src/app.ts`'s `createChatApp({ runner,
mcpUi })` factory (Step 10) — `src/http.ts` is now just dependency wiring
plus `serve()`.

### 8. Real AG-UI protocol translator for `/chat`

Done once `payments-toolkit-frontend` existed as a real consumer to
validate against — per the plan below, install `@ag-ui/core` and write
the mapping ourselves rather than porting `ag_ui_adk`'s Python source.
No TS ADK↔AG-UI bridge existed that does what we needed here (server-side
translation of a TS-run ADK agent into AG-UI events). A `typescript/`
folder does exist under
[ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)'s
`integrations/adk-middleware/`, published as `@ag-ui/adk` — but per its
own README it's "a thin TypeScript client... that connects an AG-UI
front end to an ADK-backed agent endpoint served by the companion
**Python** middleware (`ag_ui_adk`)": just `ADKAgent extends HttpAgent`
plus a `getCapabilities()` helper, no `@google/adk` import and no
agent-running logic. The actual bridge is still Python-only
(`ag_ui_adk`), confirmed by reading its source directly (2026-08-26).

- Installed `@ag-ui/core` (`0.0.58`) for the official `EventType` enum,
  `RunAgentInputSchema`, and the typed `*Event` shapes — used directly,
  not re-derived by hand.
- `/chat`'s request body is now an AG-UI `RunAgentInput`
  (`{ threadId, runId, messages, ... }`), validated with
  `RunAgentInputSchema.safeParse`, not the old `{ prompt }` shape — a
  breaking change to the endpoint's contract, but it had no consumer
  other than manual `curl` testing before this. `src/ag-ui.ts`'s
  `extractPrompt()` pulls the prompt from the last `role: 'user'`
  message, mirroring the frontend's `uiMessagesToWire` on the way in.
- `src/ag-ui.ts`'s `AgUiTranslator` maps `describeEvent`'s existing
  tool-call/tool-result/content outcomes to spec AG-UI events per run:
  `RUN_STARTED` → `TOOL_CALL_START`/`ARGS`/`END` → `TOOL_CALL_RESULT` →
  `TEXT_MESSAGE_START`/`CONTENT`/`END` → `RUN_FINISHED` (or `RUN_ERROR`,
  terminal, in place of `RUN_FINISHED`). `trace.ts`'s `EventOutcome` grew
  an optional `id` field on `toolCall`/`toolResult` (ADK's
  `FunctionCall.id`/`FunctionResponse.id`) so results correlate to their
  calls via AG-UI's `toolCallId` — additive, doesn't touch existing
  fields, existing tests still pass unmodified.
- **Client-bug workaround discovered building the frontend — now removed,
  fixed upstream (see `payments-toolkit-frontend/PLAN.md`):**
  `@tanstack/ai@0.49.1`'s `StreamProcessor` dropped the first
  `TEXT_MESSAGE_CONTENT` delta when `TOOL_CALL_START` referenced a
  message with no prior `TEXT_MESSAGE_START` — exactly this backend's
  real event order (tool calls always precede the one final content
  block; confirmed via direct event-dump against the live agent, single-
  and multi-tool-call turns both). Worked around with an empty
  `TEXT_MESSAGE_START`/`TEXT_MESSAGE_END` pair up front
  (`AgUiTranslator.open()`), same as the frontend's mock server.
  `@tanstack/ai@0.51.0` fixed it (`handleTextMessageStartEvent` resets
  the segment accumulator when the message was already marked by a tool
  call) and the frontend now runs `0.52.0`, so `open()` and its call in
  `app.ts` were deleted. Re-add the empty pair only if a client pinned to
  `@tanstack/ai` 0.49.x / 0.50.x ever consumes this stream again.
- **CORS**: `/chat` had none — the frontend is a different localhost
  origin, and its client sends a custom `X-Run-Id` header that triggers
  a preflight `OPTIONS`, which 404'd with no CORS middleware. Added
  `hono/cors` on the `/chat` route (`origin: '*'`, allowing `POST`/
  `OPTIONS` and the `Content-Type`/`X-Run-Id` headers).
- **MCP result unwrapping**: `FunctionResponse.response` arrives as the
  raw MCP envelope (`{ content: [...], structuredContent }`). Unwrapping
  to just `structuredContent` before it becomes `TOOL_CALL_RESULT.content`
  keeps the payload the clean `{ valid: true, ... }` shape the frontend's
  tool-call trace is meant to display, not the full MCP envelope. Falls
  back to the raw response for a tool that doesn't provide it.
- Verified end-to-end: `curl` against real `RunAgentInput` bodies (single
  tool call, and two parallel tool calls in one turn — correct
  correlation for both), and live against the real
  `payments-toolkit-frontend` UI — tool-call trace renders correctly
  against genuine Gemini/MCP tool calls, not the frontend's mock.

### 9. Forward MCP Apps widget resources to the frontend

`payments-toolkit-mcp`'s `detect_card_type` tool advertises an MCP Apps UI
widget via `_meta.ui.resourceUri` (a `ui://payments-toolkit/card-preview`
resource). `/chat` forwards that widget so the frontend can render it inline
with the tool result.

- `src/mcp-ui.ts`'s `McpUiResources` owns a **dedicated, persistent** MCP
  client — its own stdio child, connected once at server boot and reused
  for the life of the process — purely to resolve `ui://` resources. Kept
  separate from the ADK toolset's MCP access, which is model-driven,
  doesn't surface tool `_meta`, and (in `@google/adk@2.0.0`) spawns a
  throwaway stdio child per tool call rather than holding one open.
- On boot it lists tools, records which advertise a `ui://` resource, and
  logs the map. It also runs the shared `verifyMcpServer` sanity check
  (tools/resources/prompts present, warn if not) over this same connection,
  so the HTTP server no longer opens a second throwaway MCP child just for
  that — the CLI still uses the standalone `discoverMcpServer`. On each tool
  result in `/chat`, `forTool(name)` returns the widget's resource payload
  (body cached — static for the life of the server) or `undefined`.
- `AgUiTranslator.uiResource()` emits it as an AG-UI `CUSTOM` event
  (`name: 'ui-resource'`), correlated to the tool call by `toolCallId`,
  **after** the `TOOL_CALL_RESULT`. `@tanstack/ai`'s `StreamProcessor`
  reconciles it into a `ui-resource` message part — see
  `payments-toolkit-frontend`'s `McpAppView.vue` for the render side.
- Verified end-to-end against the real frontend: the card-preview widget
  renders alongside a genuine `detect_card_type` call.

### 10. Cancel / interrupt for an in-flight `/chat` turn

The step-2 frontend needs a Stop control. Two independent triggers, unified
into one `AbortSignal` per turn via `AbortSignal.any`:

- **Client disconnect** — `c.req.raw.signal` (`@hono/node-server` fires it
  when the browser drops the connection). Zero API surface, but fragile:
  buffering proxies can hold the upstream socket open after the user hits
  Stop, so the agent would keep burning tokens.
- **Explicit side-channel** — `POST /chat/:runId/cancel`. The frontend
  already holds `runId` (it's in every `RunAgentInput`), so it can cancel
  the moment Stop is clicked without waiting for the socket. `202` if a run
  was aborted, `404` if none is in flight (finished / unknown — a caller
  no-op). Needs its own `hono/cors` glob registration, since `/chat` is
  path-exact in Hono.
- A per-process `Map<runId, AbortController>` registry holds the controller
  for each in-flight turn; the stream's `finally` deletes it.
- The signal is threaded into `runner.runAsync({ ..., abortSignal })`.
  `runEphemeral()` doesn't forward an `abortSignal`, so `/chat` now
  hand-rolls what it did internally: `sessionService.createSession()` →
  `runAsync()` → `deleteSession()` in a `finally`. ADK fans the one signal
  out to the invocation loop (stops between steps), the Gemini streaming
  call (the real cost), and any in-flight MCP tool call.
- ADK's `runAsync` **returns** (doesn't throw) on abort, so the event loop
  just ends. A terminal AG-UI event is then emitted so the client's
  `StreamProcessor` finalizes the run instead of leaving a half-open
  "streaming" message. `@ag-ui/core@0.0.58` has no `RUN_CANCELLED`, so a
  cancelled run is reported as `RUN_ERROR` with message `"cancelled"`
  (best-effort write — on a client disconnect the socket is already gone).
- **Refactor for testability:** the `/chat` + cancel route logic moved from
  `src/http.ts` into `src/app.ts`'s `createChatApp({ runner, mcpUi })`
  factory, behind narrow `ChatRunner` / `ChatMcpUi` interfaces (the real
  `InMemoryRunner` / `McpUiResources` satisfy them structurally).
  `src/http.ts` shrank to dependency wiring plus `serve()`.
- **Observability:** run lifecycle is now recorded in `logs/agent.log` via
  the per-run logger (`run started` / `run finished` / `run cancelled` with
  `trigger: "cancel-endpoint" | "client-disconnect"` / `run error`), and a
  cancelled turn also prints a `[cancel] run <runId> aborted (<trigger>)`
  line to stderr (`[boot]`/`[shutdown]` style); the cancel endpoint logs
  `[cancel] no in-flight run <runId>` on a `404`. Before this the tool-call
  audit was the only per-request logging and cancellation was silent.
- Verified with `curl` (explicit cancel mid-run, cancel-after-finish,
  client disconnect) and `tests/unit/app.test.ts`, which drives the app via
  Hono's `app.request()` with a fake generator runner: normal completion,
  explicit cancel mid-run (terminal `RUN_ERROR`/`cancelled`, no
  `RUN_FINISHED`, registry cleaned up), client disconnect via the request
  signal, and `404` for an unknown `runId`.

## Fast-follows (explicitly out of scope for this PLAN, tracked for later)

- Switch the MCP connection itself (not this agent's own HTTP API — see
  step 7) from spawning `payments-toolkit-mcp` as a stdio child process to
  connecting over that server's own `start:http` transport instead
- Basic guardrails: spend/scope limits, input redaction before logging,
  explicit refusal handling for out-of-scope requests
- Multi-turn session state for `POST /chat` (session id, history store),
  if the frontend project turns out to need it
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
- `pnpm run start:http` exposes `POST /chat` and streams real AG-UI
  events (`RUN_STARTED`, `TOOL_CALL_*`, `TEXT_MESSAGE_*`, the `CUSTOM`
  `ui-resource` event for MCP Apps widgets, `RUN_FINISHED`/`RUN_ERROR`)
  for a full agent turn, verified against a real request and against the
  real `payments-toolkit-frontend` UI
- `POST /chat/:runId/cancel` (and a client disconnect) aborts an in-flight
  turn — killing the model request and emitting a terminal
  `RUN_ERROR`/`cancelled` — verified via `curl` and `tests/unit/app.test.ts`
- `pnpm test` passes, covering `src/`'s deterministic logic including the
  `/chat` and cancel routes
- README explains setup and scope clearly enough that a stranger (or a
  future you) could pick this up cold
