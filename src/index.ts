import 'dotenv/config';
import { EventType, InMemoryRunner, toStructuredEvents } from '@google/adk';
import { buildAgent, discoverMcpServer, getMcpServerPath } from './agent.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

async function getPrompt(): Promise<string> {
  const argPrompt = process.argv.slice(2).join(' ').trim();
  return argPrompt || readStdin();
}

async function main(): Promise<void> {
  const mcpServerPath = getMcpServerPath();
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Copy .env.example to .env and set it.',
    );
  }

  await discoverMcpServer(mcpServerPath);

  const prompt = await getPrompt();
  if (!prompt) {
    throw new Error(
      'No prompt provided. Usage: pnpm start "<question>" (or pipe one via stdin).',
    );
  }

  const { agent, mcpToolset } = buildAgent(mcpServerPath);
  const runner = new InMemoryRunner({
    agent,
    appName: 'payments-toolkit-agent',
  });

  let finalText = '';
  const runLog = createRunLogger();

  try {
    for await (const event of runner.runEphemeral({
      userId: 'cli-user',
      newMessage: { parts: [{ text: prompt }] },
    })) {
      for (const structured of toStructuredEvents(event)) {
        switch (structured.type) {
          case EventType.TOOL_CALL:
            console.log(`\n[tool call] ${structured.call.name}`);
            console.log(`  args: ${JSON.stringify(structured.call.args)}`);
            logToolCall(
              runLog,
              structured.call.name ?? 'unknown',
              structured.call.args,
            );
            break;
          case EventType.TOOL_RESULT:
            console.log(
              `[tool result] ${structured.result.name}: ${JSON.stringify(structured.result.response)}`,
            );
            logToolResult(
              runLog,
              structured.result.name ?? 'unknown',
              structured.result.response,
            );
            break;
          case EventType.CONTENT:
            finalText += structured.content;
            break;
          case EventType.ERROR:
            console.error(`\n[error] ${structured.error.message}`);
            process.exitCode = 1;
            break;
          default:
            break;
        }
      }
    }
  } finally {
    await mcpToolset.close();
  }

  console.log(`\n[response]\n${finalText}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
