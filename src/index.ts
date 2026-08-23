import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildAgentOptions,
  discoverMcpServer,
  getMcpServerPath,
} from './agent.js';

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

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join('\n');
  }
  return JSON.stringify(content);
}

async function main(): Promise<void> {
  const mcpServerPath = getMcpServerPath();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and set it.',
    );
  }

  await discoverMcpServer(mcpServerPath);

  const prompt = await getPrompt();
  if (!prompt) {
    throw new Error(
      'No prompt provided. Usage: pnpm start "<question>" (or pipe one via stdin).',
    );
  }

  const pendingCalls = new Map<string, { name: string; input: unknown }>();

  for await (const message of query({
    prompt,
    options: buildAgentOptions(mcpServerPath),
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          pendingCalls.set(block.id, { name: block.name, input: block.input });
          console.log(`\n[tool call] ${block.name}`);
          console.log(`  args: ${JSON.stringify(block.input)}`);
        }
      }
    } else if (message.type === 'user') {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const call = pendingCalls.get(block.tool_use_id);
            const label = call?.name ?? block.tool_use_id;
            console.log(
              `[tool result] ${label}: ${extractResultText(block.content)}`,
            );
          }
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        console.log(`\n[response]\n${message.result}`);
      } else {
        console.error(`\n[error] ${message.subtype}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
