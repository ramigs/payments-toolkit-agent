import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { EventType, InMemoryRunner, toStructuredEvents } from '@google/adk';
import { buildAgent, discoverMcpServer, getMcpServerPath } from './agent.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';
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

const app = new Hono();

app.post('/chat', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400);
  }

  const prompt =
    typeof body === 'object' && body !== null && 'prompt' in body
      ? (body as { prompt: unknown }).prompt
      : undefined;

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return c.json({ error: '"prompt" must be a non-empty string.' }, 400);
  }

  // Single-turn: each request runs one ephemeral agent turn and streams its
  // events back, with no conversation state kept between requests (same
  // model as the CLI's one-shot pnpm start, just over HTTP).
  return streamSSE(c, async (stream) => {
    const runLog = createRunLogger();

    for await (const event of runner.runEphemeral({
      userId: 'http-user',
      newMessage: { parts: [{ text: prompt }] },
    })) {
      for (const structured of toStructuredEvents(event)) {
        const outcome = describeEvent(structured);

        if (outcome.toolCall) {
          logToolCall(runLog, outcome.toolCall.name, outcome.toolCall.args);
          await stream.writeSSE({
            event: 'tool_call',
            data: JSON.stringify(outcome.toolCall),
          });
        }
        if (outcome.toolResult) {
          logToolResult(
            runLog,
            outcome.toolResult.name,
            outcome.toolResult.result,
          );
          await stream.writeSSE({
            event: 'tool_result',
            data: JSON.stringify(outcome.toolResult),
          });
        }
        if (outcome.contentDelta) {
          await stream.writeSSE({
            event: 'content',
            data: JSON.stringify({ text: outcome.contentDelta }),
          });
        }
        if (structured.type === EventType.ERROR) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: structured.error.message }),
          });
        }
      }
    }

    await stream.writeSSE({ event: 'done', data: '{}' });
  });
});

const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `[boot] payments-toolkit-agent HTTP server listening on port ${info.port}`,
  );
});

async function shutdown(): Promise<void> {
  console.error('[shutdown] closing MCP connection...');
  await mcpToolset.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
