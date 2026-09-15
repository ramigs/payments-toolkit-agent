import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { EventType, toStructuredEvents, type Event } from '@google/adk';
import { RunAgentInputSchema } from '@ag-ui/core';
import { ADK_MODEL } from './agent.js';
import { AgUiTranslator, extractPrompt, type AgUiEvent } from './ag-ui.js';
import type { TokenVerifier } from './auth.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';
import { describeEvent } from './trace.js';
import type { UiResourcePayload } from './mcp-ui.js';
import { pickSampleCards } from './sample-cards.js';
import { pickSampleIbans } from './sample-ibans.js';

export const APP_NAME = 'payments-toolkit-agent-http';
const USER_ID = 'http-user';

/**
 * The slice of `@google/adk`'s `InMemoryRunner` the `/chat` route actually
 * touches. Narrowed to an interface so tests can inject a fake turn instead
 * of standing up a model and an MCP connection — the real runner satisfies
 * this structurally.
 */
export interface ChatRunner {
  sessionService: {
    createSession(params: {
      appName: string;
      userId: string;
    }): Promise<{ id: string }>;
    deleteSession(params: {
      appName: string;
      userId: string;
      sessionId: string;
    }): Promise<unknown>;
  };
  runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: { parts: Array<{ text: string }> };
    abortSignal?: AbortSignal;
  }): AsyncIterable<Event>;
}

/** The slice of `McpUiResources` the `/chat` route uses. */
export interface ChatMcpUi {
  forTool(toolName: string): Promise<UiResourcePayload | undefined>;
}

export interface ChatAppDeps {
  runner: ChatRunner;
  mcpUi: ChatMcpUi;
  /**
   * Verifies the `Authorization` header on every route below. Injected (rather
   * than built in here) so tests pass a stub instead of real JWTs; the server
   * wires `createSupabaseTokenVerifier` in `http.ts`.
   */
  verifyToken: TokenVerifier;
}

async function emit(
  stream: SSEStreamingApi,
  ...events: AgUiEvent[]
): Promise<void> {
  for (const event of events) {
    await stream.writeSSE({ data: JSON.stringify(event) });
  }
}

/**
 * Whether a completed tool result is a validation that explicitly failed
 * (`structuredContent.valid === false`).
 *
 * Used to withhold the MCP Apps widget for invalid input — a preview tile
 * for a bad IBAN is noise, not an error. This is the same "only when valid"
 * rule the system prompt applies to `detect_card_type` (there the model just
 * doesn't call the widget-bound tool); `validate_iban` both validates and
 * carries the widget, so nothing upstream can withhold it and the check
 * lands here instead.
 */
export function isFailedValidation(result: unknown): boolean {
  const inner =
    result !== null &&
    typeof result === 'object' &&
    'structuredContent' in result
      ? (result as { structuredContent: unknown }).structuredContent
      : result;
  return (
    inner !== null &&
    typeof inner === 'object' &&
    (inner as { valid?: unknown }).valid === false
  );
}

/**
 * Builds the Hono app for the agent HTTP surface: `POST /chat` (single-turn,
 * SSE-streamed AG-UI events), the `POST /chat/:runId/cancel` side-channel,
 * `GET /sample-cards` / `GET /sample-ibans` (static helpers the frontend
 * uses to seed a "try a sample" picker), and `GET /model-info` (the model
 * name, for the frontend to display once under the chat box rather than on
 * every streamed run). All request-scoped state (the
 * in-flight-run registry) lives inside this closure, so each call returns an
 * independent app — one for the server, fresh ones per test.
 */
export function createChatApp({
  runner,
  mcpUi,
  verifyToken,
}: ChatAppDeps): Hono {
  const app = new Hono();

  // Every route here is gated: the frontend attaches a Supabase bearer token
  // (payments-toolkit-frontend's useAgentChat), so anything without a valid one
  // — a direct curl, an expired session — gets a 401 before any model, MCP, or
  // sample work. Runs after the per-route `cors()` middleware, which answers the
  // preflight OPTIONS itself and never calls `next()`, so this only sees real
  // requests. `verifyToken` resolves with the caller's `userId` — the hook for
  // per-user rate limiting (PLAN step 6) — but nothing consumes it yet.
  const requireAuth: MiddlewareHandler = async (c, next) => {
    try {
      await verifyToken(c.req.header('Authorization'));
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  };

  // Static GET helpers: sample payment details for the frontend's one-tap
  // input (one test card per network, one IBAN per country) and the model
  // name for its "powered by" display. All GET-only and stateless, with
  // their own permissive CORS separate from the `/chat` POST rules below —
  // but the same auth gate. CORS + auth go on `app.use` (all methods), not
  // the `app.get` handler: the bearer token makes these preflighted, and an
  // `OPTIONS` would miss a GET-only registration and 404.
  const sampleCors = cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization'],
  });
  for (const path of ['/sample-cards', '/sample-ibans', '/model-info']) {
    app.use(path, sampleCors, requireAuth);
  }
  app.get('/sample-cards', (c) => c.json(pickSampleCards()));
  app.get('/sample-ibans', (c) => c.json(pickSampleIbans()));
  app.get('/model-info', (c) => c.json({ model: ADK_MODEL }));

  // In-flight turn registry, keyed by AG-UI runId. A turn registers its
  // AbortController here for its lifetime so the side-channel
  // `POST /chat/:runId/cancel` can abort it. The zero-API-surface path
  // (client disconnect closing the socket) is handled separately via
  // `c.req.raw.signal`; this map exists because buffering proxies can keep
  // the upstream socket open long after the user hit Stop, so the agent
  // would otherwise keep burning tokens.
  const inFlightRuns = new Map<string, AbortController>();

  // The frontend (payments-toolkit-frontend, a separate localhost origin) is
  // the only real consumer of this endpoint (see that repo's PLAN.md, step
  // 2) — cross-origin requests are the norm here, not an edge case, and the
  // client's fetchServerSentEvents adapter sends a custom X-Run-Id header
  // plus an Authorization bearer token (Supabase session), both of which
  // trigger a CORS preflight.
  const chatCors = cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Run-Id'],
  });
  // `/chat/*` also matches bare `/chat` in this Hono version, so the glob
  // covers both the endpoint and the `/chat/:runId/cancel` side-channel; the
  // exact `/chat` line is kept only so CORS is unmistakably attached to it.
  // `cors` runs first (it answers the preflight and doesn't call `next()`), so
  // `requireAuth` only ever sees a real request — once.
  app.use('/chat', chatCors);
  app.use('/chat/*', chatCors, requireAuth);

  app.post('/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const parsed = RunAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Request body must be a valid AG-UI RunAgentInput.' },
        400,
      );
    }

    const prompt = extractPrompt(parsed.data);
    if (!prompt || prompt.trim() === '') {
      return c.json(
        { error: 'No non-empty "user" message found in "messages".' },
        400,
      );
    }

    const { threadId, runId } = parsed.data;

    // Single-turn: each request runs one agent turn and streams its events
    // back, with no conversation state kept between requests (same model as
    // the CLI's one-shot pnpm start, just over HTTP). This replicates what
    // `runner.runEphemeral` does internally — create a throwaway session,
    // run, delete it — because `runEphemeral` doesn't forward an
    // `abortSignal` to `runAsync`, and cancellation is the whole point here.
    return streamSSE(c, async (stream) => {
      const runLog = createRunLogger().child({ threadId, runId });
      const translator = new AgUiTranslator(threadId, runId);
      let errored = false;

      // Cancellation has two independent triggers, unified into one signal:
      //   - `c.req.raw.signal` fires when the browser drops the connection
      //     (zero API surface, but fragile — proxies can hold the socket
      //     open);
      //   - `cancelController` is aborted by `POST /chat/:runId/cancel`.
      // Aborting `runAsync` stops the invocation loop between steps and, more
      // importantly, kills the in-flight Gemini stream and any in-flight MCP
      // tool call (ADK fans the signal out to both).
      const cancelController = new AbortController();
      const abortSignal = AbortSignal.any([
        c.req.raw.signal,
        cancelController.signal,
      ]);
      inFlightRuns.set(runId, cancelController);

      const session = await runner.sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
      });

      try {
        runLog.info('run started');
        await emit(stream, translator.runStarted());

        outer: for await (const event of runner.runAsync({
          userId: USER_ID,
          sessionId: session.id,
          newMessage: { parts: [{ text: prompt }] },
          abortSignal,
        })) {
          for (const structured of toStructuredEvents(event)) {
            const outcome = describeEvent(structured);

            if (outcome.toolCall) {
              logToolCall(runLog, outcome.toolCall.name, outcome.toolCall.args);
              await emit(
                stream,
                ...translator.toolCall(
                  outcome.toolCall.name,
                  outcome.toolCall.args,
                  outcome.toolCall.id,
                ),
              );
            }
            if (outcome.toolResult) {
              const { name, result, id } = outcome.toolResult;
              logToolResult(runLog, name, result);
              await emit(stream, translator.toolResult(name, result, id));

              // If this tool advertises an MCP Apps widget, forward its
              // resource so the frontend can render it alongside the result —
              // but not for a validation that failed (an invalid IBAN gets no
              // preview tile).
              if (!isFailedValidation(result)) {
                const widget = await mcpUi.forTool(name);
                if (widget) {
                  await emit(stream, translator.uiResource(name, id, widget));
                }
              }
            }
            if (outcome.contentDelta) {
              await emit(stream, ...translator.content(outcome.contentDelta));
            }
            if (structured.type === EventType.ERROR) {
              errored = true;
              runLog.error({ message: structured.error.message }, 'run error');
              await emit(stream, translator.runError(structured.error.message));
              break outer;
            }
          }
        }

        // ADK's `runAsync` returns (doesn't throw) when the signal aborts,
        // so the loop above just ends. Emit a terminal event so the client's
        // StreamProcessor finalizes the run instead of leaving a half-open
        // assistant message stuck in "streaming". @ag-ui/core has no
        // RUN_CANCELLED in the pinned canary, so a cancelled run is reported
        // as RUN_ERROR with message "cancelled". The write is best-effort: on
        // a client disconnect the socket is already gone; on an explicit
        // cancel the SSE stream is still open and the event lands.
        if (abortSignal.aborted && !errored) {
          errored = true;
          const trigger = cancelController.signal.aborted
            ? 'cancel-endpoint'
            : 'client-disconnect';
          runLog.info({ trigger }, 'run cancelled');
          console.error(`[cancel] run ${runId} aborted (${trigger})`);
          try {
            await emit(stream, translator.runError('cancelled'));
          } catch {
            // stream already closed by the disconnect — nothing to deliver to
          }
        }

        if (!errored) {
          runLog.info('run finished');
          await emit(stream, translator.runFinished());
        }
      } finally {
        inFlightRuns.delete(runId);
        await runner.sessionService
          .deleteSession({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId: session.id,
          })
          .catch(() => {
            // throwaway session; a failed cleanup must not break stream close
          });
      }
    });
  });

  // Side-channel cancel for an in-flight turn. The frontend already holds the
  // runId (it's in every RunAgentInput it sends), so it can hit this the
  // moment the user clicks Stop, without waiting for the SSE socket to drop.
  app.post('/chat/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    const controller = inFlightRuns.get(runId);
    if (!controller) {
      // Already finished, already cancelled, or never existed — all no-ops
      // from the caller's point of view.
      console.error(`[cancel] no in-flight run ${runId}`);
      return c.json({ error: 'No in-flight run with that runId.' }, 404);
    }
    controller.abort();
    // The `[cancel] run <runId> aborted` line and the `run cancelled` audit
    // entry are emitted by the stream handler once it unwinds — covering
    // this path and a client disconnect with one code path.
    return c.body(null, 202);
  });

  return app;
}
