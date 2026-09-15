import 'dotenv/config';
import { serve } from '@hono/node-server';
import { InMemoryRunner } from '@google/adk';
import { buildAgent, getMcpServerPath } from './agent.js';
import { createSupabaseTokenVerifier } from './auth.js';
import { McpUiResources } from './mcp-ui.js';
import { APP_NAME, createChatApp } from './app.js';

const mcpServerPath = getMcpServerPath();
if (!process.env.GEMINI_API_KEY) {
  throw new Error(
    'GEMINI_API_KEY is not set. Copy .env.example to .env and set it.',
  );
}
if (!process.env.SUPABASE_URL) {
  throw new Error(
    'SUPABASE_URL is not set. Copy .env.example to .env and set it to your ' +
      'Supabase project URL — /chat and the sample routes verify the bearer ' +
      'token the frontend sends against that project.',
  );
}

// Built once at server startup and reused across requests — unlike the CLI
// runner, which builds a fresh agent per invocation since it exits after one
// turn, this process stays up.
//
// Note this does NOT keep a warm MCP connection: @google/adk@2.0.0's
// MCPToolset/MCPTool open and close a fresh stdio connection (a new
// `node <mcpServerPath>` child) for every tool-list resolution and every
// individual tool call, then discard it. `mcpToolset` here only carries the
// connection params; `mcpToolset.close()` on shutdown is a straggler cleanup.
// The one genuinely persistent MCP client we own is `mcpUi` below.
const { agent, mcpToolset } = buildAgent(mcpServerPath);
const runner = new InMemoryRunner({
  agent,
  appName: APP_NAME,
});

// Resolves the `ui://` widget resource for any MCP Apps tool (currently
// detect_card_type) so /chat can forward it to the frontend. Unlike the ADK
// toolset above, this holds a single MCP client open for the life of the
// server and reuses it for every resource read. `connect()` also runs the
// boot-time MCP sanity check (`verifyMcpServer`) over this connection, so
// the HTTP server doesn't spawn a separate throwaway child for it the way
// the CLI's `discoverMcpServer` does.
const mcpUi = new McpUiResources();
await mcpUi.connect(mcpServerPath);

const verifyToken = createSupabaseTokenVerifier(process.env.SUPABASE_URL);

const app = createChatApp({ runner, mcpUi, verifyToken });

const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `[boot] payments-toolkit-agent HTTP server listening on port ${info.port}`,
  );
});

async function shutdown(): Promise<void> {
  console.log('[shutdown] closing MCP connections...');
  await Promise.allSettled([mcpToolset.close(), mcpUi.close()]);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
