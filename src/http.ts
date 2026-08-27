import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { EventType, InMemoryRunner, toStructuredEvents } from '@google/adk';
import { RunAgentInputSchema } from '@ag-ui/core';
import { buildAgent, discoverMcpServer, getMcpServerPath } from './agent.js';
import { AgUiTranslator, extractPrompt, type AgUiEvent } from './ag-ui.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';
import { McpUiResources } from './mcp-ui.js';
import { describeEvent } from './trace.js';

const mcpServerPath = getMcpServerPath();
if (!process.env.GEMINI_API_KEY) {
  throw new Error(
    'GEMINI_API_KEY is not set. Copy .env.example to .env and set it.',
  );
}

await discoverMcpServer(mcpServerPath);

// Built once at server startup and reused across requests — unlike the CLI
// runner, which builds a fresh agent per invocation since it exits after
// one turn, this process stays up, so one MCP child process/connection
// serves every request.
const { agent, mcpToolset } = buildAgent(mcpServerPath);
const runner = new InMemoryRunner({
  agent,
  appName: 'payments-toolkit-agent-http',
});

// Resolves the `ui://` widget resource for any MCP Apps tool (currently
// detect_card_type) so /chat can forward it to the frontend. Held open
// for the life of the server, like the toolset connection above.
const mcpUi = new McpUiResources();
await mcpUi.connect(mcpServerPath);

const app = new Hono();

// The frontend (payments-toolkit-frontend, a separate localhost origin) is
// the only real consumer of this endpoint (see that repo's PLAN.md, step
// 2) — cross-origin requests are the norm here, not an edge case, and the
// client's fetchServerSentEvents adapter sends a custom X-Run-Id header
// that triggers a CORS preflight.
app.use(
  '/chat',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Run-Id'],
  }),
);

async function emit(
  stream: SSEStreamingApi,
  ...events: AgUiEvent[]
): Promise<void> {
  for (const event of events) {
    await stream.writeSSE({ data: JSON.stringify(event) });
  }
}

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

  // Single-turn: each request runs one ephemeral agent turn and streams its
  // events back, with no conversation state kept between requests (same
  // model as the CLI's one-shot pnpm start, just over HTTP).
  return streamSSE(c, async (stream) => {
    const runLog = createRunLogger();
    const translator = new AgUiTranslator(threadId, runId);
    let errored = false;

    await emit(stream, translator.runStarted(), ...translator.open());

    outer: for await (const event of runner.runEphemeral({
      userId: 'http-user',
      newMessage: { parts: [{ text: prompt }] },
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
          await emit(stream, translator.runError(structured.error.message));
          break outer;
        }
      }
    }

    if (!errored) {
      await emit(stream, translator.runFinished());
    }
  });
});

const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `[boot] payments-toolkit-agent HTTP server listening on port ${info.port}`,
  );
});

async function shutdown(): Promise<void> {
  console.error('[shutdown] closing MCP connections...');
  await Promise.allSettled([mcpToolset.close(), mcpUi.close()]);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
