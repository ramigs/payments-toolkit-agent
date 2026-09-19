# payments-toolkit-agent

Payments Toolkit is a validation assistant for **card numbers** and **IBANs**.
Ask in plain English — it checks card numbers (Luhn checksum and card network)
and IBANs (format, country length, checksum) by running real validators.

Learn more: [What I learned building my first end-to-end AI
app](https://ramigs.dev/blog/what-i-learned-building-my-first-end-to-end-ai-app/)

This is the agent backend, built with [Google
ADK](https://google.github.io/adk-docs/), that connects to
[payments-toolkit-mcp](https://github.com/ramigs/payments-toolkit-mcp) as an MCP
server.

The agent is scoped narrowly to payment-detail validation (card numbers, card
types, IBANs) via its system prompt (`src/agent.ts`) and declines anything else.

This backend is consumed by
[payments-toolkit-frontend](https://github.com/ramigs/payments-toolkit-frontend),
an AG-UI-based frontend that talks to it over the HTTP endpoint documented
below.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [Environment variables](#environment-variables)
- [Usage](#usage)
  - [CLI](#cli)
  - [HTTP server](#http-server)
    - [POST /chat](#post-chat)
    - [POST /chat/:runId/cancel](#post-chatrunidcancel)
    - [GET /sample-cards](#get-sample-cards)
    - [GET /sample-ibans](#get-sample-ibans)
    - [GET /model-info](#get-model-info)
  - [Type-checking, linting, formatting, building](#type-checking-linting-formatting-building)
- [Deploy](#deploy)
- [Logging](#logging)
- [Eval suite](#eval-suite)
- [Unit tests](#unit-tests)
- [TODO](#todo)
  - [AG-UI translation](#ag-ui-translation)
  - [Guardrails against runaway spend](#guardrails-against-runaway-spend)
  - [Deployment hardening](#deployment-hardening)
  - [Eval hardening](#eval-hardening)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Prerequisites

- Node.js 20.3+ (for `AbortSignal.any`; project developed against v24, pinned
  via `.nvmrc`)
- [pnpm](https://pnpm.io)
- [`payments-toolkit-mcp`](https://github.com/ramigs/payments-toolkit-mcp)
  running locally over HTTP (`pnpm run start:http` in that repo) — this agent
  talks to it over the network, not as a spawned child process
- A Gemini API key (from [Google AI
  Studio](https://aistudio.google.com/app/apikey))
- For `pnpm run start:http`: a [Supabase](https://supabase.com) project (free
  tier) — `/chat` and the sample routes verify the bearer token the frontend
  sends against it

## Setup

```bash
pnpm install
```

### Environment variables

```bash
cp .env.example .env
```

Then fill in `.env`:

- `GEMINI_API_KEY` — from [Google AI
  Studio](https://aistudio.google.com/app/apikey), used by Google ADK.
- `MCP_SERVER_URL` — the URL to the MCP server's `/mcp` endpoint, e.g.
  `http://localhost:3000/mcp` after running `pnpm run start:http` in that repo
  locally, or its Railway private-network address in production (e.g.
  `http://payments-toolkit-mcp.railway.internal:3000/mcp`).
- `MCP_AUTH_TOKEN` — shared-secret bearer token sent to the MCP server on
  every request; must match the value configured on that server (see its own
  `.env.example`/`MCP_AUTH_TOKEN`).
- `SUPABASE_URL` — required for `pnpm run start:http`: your Supabase project URL
  (Project Settings → API), e.g. `https://xxxxxxxxxxxx.supabase.co`. The HTTP
  server fetches that project's JWKS to verify the Supabase session token
  `payments-toolkit-frontend` attaches to every `/chat` request; an
  unauthenticated request gets a 401. The CLI (`pnpm start`) doesn't use it.
- `PORT` — optional, default `3001` (only used by `pnpm run start:http`).

`.env` is gitignored.

## Usage

There are two ways to run the agent: a single-turn CLI call (below), or a
long-lived HTTP server for the frontend to talk to.

### CLI

Run a single agent turn against the real MCP server:

```bash
pnpm start "Is DE89370400440532013000 a valid IBAN?"
```

This is intentionally not a REPL — one request in, one full trace out. Each run
prints, in order:

1. The discovered MCP tools/resources/prompts (a boot-time sanity check)
2. Each tool call the agent makes, with arguments
3. Each tool's raw result
4. The agent's final natural-language response

### HTTP server

Run the agent as a long-lived HTTP server instead of a one-shot CLI call:

```bash
pnpm run start:http
```

Listens on `PORT` (default `3001`). Every route requires a valid Supabase bearer
token — the one `payments-toolkit-frontend` obtains at login and attaches to
each request. The token's signature, expiry, issuer, and `authenticated`
audience are checked against the project JWKS (`src/auth.ts`); anything missing
or invalid gets a `401` before any model, MCP, or sample-data work.

- [`POST /chat`](#post-chat)
- [`POST /chat/:runId/cancel`](#post-chatrunidcancel)
- [`GET /sample-cards`](#get-sample-cards)
- [`GET /sample-ibans`](#get-sample-ibans)
- [`GET /model-info`](#get-model-info)

#### POST /chat

```
Content-Type: application/json
Authorization: Bearer <Supabase access token>

<an AG-UI RunAgentInput: { threadId, runId, messages, ... }>
```

The request body is a full [AG-UI](https://docs.ag-ui.com) `RunAgentInput`
(validated with `@ag-ui/core`'s `RunAgentInputSchema`); the prompt is taken from
the last `role: "user"` message. The response is a Server-Sent Events stream of
official AG-UI events — one full agent turn per request, no conversation state
kept between requests (the frontend project owns session/thread identity if it
needs multi-turn memory):

```
RUN_STARTED → TOOL_CALL_START/ARGS/END → TOOL_CALL_RESULT →
TEXT_MESSAGE_START/CONTENT/END → RUN_FINISHED
```

A tool that advertises an [MCP Apps](https://github.com/modelcontextprotocol)
widget (currently `detect_card_type`) also emits a `CUSTOM` event with `name:
"ui-resource"` after its `TOOL_CALL_RESULT`, carrying the widget resource for
the frontend to render. On failure, a terminal
`{"type":"RUN_ERROR","message":"..."}` replaces `RUN_FINISHED`.

#### POST /chat/:runId/cancel

Cancels an in-flight turn: aborts the model request (and any in-flight MCP tool
call), then closes the stream with `RUN_ERROR` / `"cancelled"`. Returns `202` if
a run was aborted, `404` if none is in flight (already finished, or unknown
`runId`). Dropping the `/chat` connection cancels the turn the same way — the
endpoint just doesn't depend on the socket closing, which a proxy can delay.

#### GET /sample-cards

Returns one randomly chosen valid test card per network, for the frontend to
offer as one-tap sample input:

```json
[{ "cardType": "Visa", "cardNumber": "4242424242424242" }, ...]
```

Numbers are drawn from a curated pool of the standard processor test PANs
(`src/sample-cards.ts`) — every one is Luhn-valid and on a real IIN range for
its network, but they're not real accounts and authorize nothing. The pool is
trusted as-is; nothing round-trips through the MCP server.

#### GET /sample-ibans

The IBAN counterpart — one randomly chosen valid IBAN per country:

```json
[{ "countryCode": "DE", "country": "Germany", "iban": "DE89370400440532013000" }, ...]
```

Drawn from the canonical registry example IBANs (`src/sample-ibans.ts`) — every
one passes the mod-97 checksum and its country-specific length. Same trust model
as `/sample-cards`: taken as-is, no MCP round-trip.

#### GET /model-info

Returns the model name for the frontend to display:

```json
{ "model": "gemini-3.5-flash-lite" }
```

### Type-checking, linting, formatting, building

```bash
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # eslint .
pnpm run lint:fix      # eslint . --fix
pnpm run format        # prettier --write .
pnpm run format:check  # prettier --check .
pnpm run build         # type-checks, then compiles to dist/
pnpm run toc           # regenerates this README's table of contents
```

## Deploy

```bash
pnpm run deploy  # railway up
pnpm run stop    # railway down
```

Deploys as a Docker image (`Dockerfile`) to [Railway](https://railway.app).
This script just wraps the Railway CLI, so a project already linked
(`railway login` / `railway link`) is a prerequisite — `pnpm run deploy`
doesn't set that up for you.

`payments-toolkit-mcp` is deployed separately, as its own Railway service in
the same project, reached over HTTP — see that repo's README for its own
Dockerfile/deploy notes. This service is expected to reach it on Railway's
private network (no public domain on the MCP service), with `MCP_SERVER_URL`
pointed at its internal hostname and `MCP_AUTH_TOKEN` matching the value
configured there.

`GEMINI_API_KEY`, `SUPABASE_URL`, `MCP_SERVER_URL`, and `MCP_AUTH_TOKEN` are
required at runtime and are intentionally not baked into the image — set them
as Railway secrets. `PORT` defaults to `3001` inside the image, same as local
dev.

## Logging

Every tool call is also logged as structured JSON to stdout (`src/logging.ts`),
with sensitive arguments (card numbers, IBANs) masked to their last 4
characters — Railway captures/routes it from there, no file or volume to
manage. Pipe it through `pino-pretty` (a dev dependency) to read it by hand,
e.g.:

```bash
pnpm start "Is 4242424242424242 a valid card number?" | pnpm exec pino-pretty
```

This log is for human/audit observability — the eval suite below does **not**
read it, since the masking would hide argument details some scenarios need to
check (see `eval/run-eval.ts`).

## Eval suite

`payments-toolkit-agent`'s behavior — which tool it picks, what arguments it
passes, how faithfully it relays a result, whether it declines or asks for
clarification appropriately — isn't deterministic, so it's checked with a
scenario-based eval rather than unit tests. See `eval/scenarios.ts` for the 13
scenarios and `eval/JOURNAL.md` for a running log of what this suite has
actually found (and fixed) so far.

Run the full suite:

```bash
pnpm run eval
```

Each scenario is graded independently on three axes — which tool(s) were called,
whether the arguments were constructed correctly, and whether the final response
is accurate — so a wrong-tool failure and a mis-relayed-result failure are
distinguishable at a glance instead of collapsing into one pass/fail mark.

Run a subset by scenario id, useful when checking a single fix without
re-running (and re-paying for) the whole suite:

```bash
pnpm run eval card-valid-reports-brand ambiguous-clarify
```

Each scenario runs once per invocation — a single sample of the model's
behavior, not a guaranteed-repeatable result. Run the suite more than once if a
failure looks surprising before treating it as a real finding.

## Unit tests

```bash
pnpm test              # run the full suite once
pnpm run test:watch    # re-run on file changes
pnpm run test:coverage # run once and print a coverage report
```

These cover the deterministic logic in `src/` — event mapping, argument
masking, prompt parsing, agent config (env var handling, tool/model wiring),
sample-data pool validity, the `/chat` + cancel routes via a fake runner, and
the `/sample-cards` + `/sample-ibans` routes (response shape, CORS) — a
different, narrower concern than the eval suite above, which checks the agent's
own decisions.

## TODO

Tracked for later, not required for this iteration to be considered done:

### AG-UI translation

- **Replace the hand-written ADK → AG-UI translation with an official bridge,
  once one exists.** `src/ag-ui.ts` translates the ADK event stream to AG-UI
  events by hand. No TypeScript package does this today — the published
  `@ag-ui/adk` is just a client for a Python middleware (`ag_ui_adk`), not an
  ADK-aware translator — so revisit this once the AG-UI project ships a real
  TypeScript ADK integration.

### Guardrails against runaway spend

Now that the access gate (Supabase auth) is up, this is the spend-limit slice of
the original "basic guardrails" work — input redaction before logging and
explicit refusal handling for out-of-scope requests are still open too,
unchanged:

- **Per-user quota** keyed on `userId`: requests/min + requests/day, `429` when
  exceeded. An in-memory token bucket is fine while the agent is
  single-instance; move to a Supabase table or Redis if it ever scales out.
- **Global circuit breaker**: cap total requests/hour, `429` when tripped.
- **Cap `max_output_tokens`**; keep the cheap model.
- **Google Cloud backstop**: budget alert + hard quota ceiling on
  `generativelanguage.googleapis.com` (per-minute and per-day) — holds even if
  everything above is bypassed.

### Deployment hardening

- **Lock down CORS** to the frontend's real origin — `/chat` and the sample-data
  routes still allow `origin: '*'`.
- **HTTPS on both sides**, so bearer tokens never transit in the clear.

### Eval hardening

- **Repeated trials per scenario** with a pass-rate instead of a single
  run/boolean.
- **Upgrade the response-text axis** from heuristic checks to an LLM-as-judge,
  if phrasing variance makes heuristics flaky in practice.
