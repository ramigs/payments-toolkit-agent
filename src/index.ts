import 'dotenv/config';
import { InMemoryRunner, toStructuredEvents } from '@google/adk';
import {
  buildAgent,
  discoverMcpServer,
  getMcpServerUrl,
  getMcpAuthToken,
} from './agent.js';
import { createRunLogger, logToolCall, logToolResult } from './logging.js';
import { getPrompt } from './prompt.js';
import { describeEvent } from './trace.js';

async function main(): Promise<void> {
  const mcpConnection = {
    mcpServerUrl: getMcpServerUrl(),
    mcpAuthToken: getMcpAuthToken(),
  };
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Copy .env.example to .env and set it.',
    );
  }

  await discoverMcpServer(mcpConnection);

  const prompt = await getPrompt();
  if (!prompt) {
    throw new Error(
      'No prompt provided. Usage: pnpm start "<question>" (or pipe one via stdin).',
    );
  }

  const { agent, mcpToolset } = buildAgent(mcpConnection);
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
        const outcome = describeEvent(structured);

        for (const line of outcome.consoleLines) {
          if (outcome.toStderr) {
            console.error(line);
          } else {
            console.log(line);
          }
        }

        if (outcome.toolCall) {
          logToolCall(runLog, outcome.toolCall.name, outcome.toolCall.args);
        }
        if (outcome.toolResult) {
          logToolResult(
            runLog,
            outcome.toolResult.name,
            outcome.toolResult.result,
          );
        }
        if (outcome.contentDelta) {
          finalText += outcome.contentDelta;
        }
        if (outcome.isError) {
          process.exitCode = 1;
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
