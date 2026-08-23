import { EventType, type StructuredEvent } from '@google/adk';

export interface EventOutcome {
  consoleLines: string[];
  toStderr?: boolean;
  toolCall?: { name: string; args: Record<string, unknown> | undefined };
  toolResult?: { name: string; result: unknown };
  contentDelta?: string;
  isError?: boolean;
}

/**
 * Maps one structured ADK event to what the CLI should print/log, with no
 * side effects — kept separate from index.ts so it can be unit tested
 * without a real Runner, model, or MCP connection.
 */
export function describeEvent(structured: StructuredEvent): EventOutcome {
  switch (structured.type) {
    case EventType.TOOL_CALL: {
      const name = structured.call.name ?? 'unknown';
      return {
        consoleLines: [
          `\n[tool call] ${name}`,
          `  args: ${JSON.stringify(structured.call.args)}`,
        ],
        toolCall: { name, args: structured.call.args },
      };
    }
    case EventType.TOOL_RESULT: {
      const name = structured.result.name ?? 'unknown';
      return {
        consoleLines: [
          `[tool result] ${name}: ${JSON.stringify(structured.result.response)}`,
        ],
        toolResult: { name, result: structured.result.response },
      };
    }
    case EventType.CONTENT:
      return { consoleLines: [], contentDelta: structured.content };
    case EventType.ERROR:
      return {
        consoleLines: [`\n[error] ${structured.error.message}`],
        toStderr: true,
        isError: true,
      };
    default:
      return { consoleLines: [] };
  }
}
