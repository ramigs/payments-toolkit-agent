import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { EventType, toStructuredEvents, type Event } from '@google/adk';
import { RunAgentInputSchema } from '@ag-ui/core';
import { AgUiTranslator, extractPrompt, type AgUiEvent } from './ag-ui.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';
import { describeEvent } from './trace.js';
import type { UiResourcePayload } from './mcp-ui.js';

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
 * Builds the Hono app for the agent HTTP surface: `POST /chat` (single-turn,
 * SSE-streamed AG-UI events) plus the `POST /chat/:runId/cancel` side-channel.
 * All request-scoped state (the in-flight-run registry) lives inside this
 * closure, so each call returns an independent app — one for the server,
 * fresh ones per test.
 */
export function createChatApp({ runner, mcpUi }: ChatAppDeps): Hono {
  const app = new Hono();

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
  // that triggers a CORS preflight.
  const chatCors = cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Run-Id'],
  });
  // `/chat` is path-exact in Hono; the cancel side-channel lives under
  // `/chat/:runId/cancel`, so it needs its own glob registration.
  app.use('/chat', chatCors);
  app.use('/chat/*', chatCors);

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
        await emit(stream, translator.runStarted(), ...translator.open());

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
              // resource so the frontend can render it alongside the result.
              const widget = await mcpUi.forTool(name);
              if (widget) {
                await emit(stream, translator.uiResource(name, id, widget));
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
