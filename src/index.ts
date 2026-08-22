import 'dotenv/config';
import { discoverMcpServer, getMcpServerPath } from './agent.js';

async function main(): Promise<void> {
  const mcpServerPath = getMcpServerPath();
  await discoverMcpServer(mcpServerPath);

  // Step 3 will replace this with a single-turn agent run driven by a CLI
  // arg / stdin prompt.
  console.error('[boot] MCP server registration confirmed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
