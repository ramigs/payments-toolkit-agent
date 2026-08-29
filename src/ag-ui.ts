import {
  EventType,
  type CustomEvent,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from '@ag-ui/core';
import type { UiResourcePayload } from './mcp-ui.js';

export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | CustomEvent;

/**
 * Extracts the prompt to run from an AG-UI `RunAgentInput` — the last
 * `role: 'user'` message's text content. Mirrors
 * payments-toolkit-frontend's `uiMessagesToWire` on the way in: a user
 * message's `content` is either a plain string or an array of content
 * parts, of which only `{ type: 'text' }` parts matter for this
 * text-only backend.
 */
export function extractPrompt(input: RunAgentInput): string | undefined {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            part.type === 'text',
        )
        .map((part) => part.text)
        .join('');
    }
  }
  return undefined;
}

/**
 * MCP tool results arrive wrapped as `{ content: [...], structuredContent }`
 * — the raw MCP content-block envelope plus, for our own tools, the same
 * data already parsed. Unwrapping to just `structuredContent` keeps the
 * AG-UI `TOOL_CALL_RESULT` payload the clean `{ valid: true, ... }` shape
 * the frontend's tool-call trace is meant to display, instead of the full
 * MCP envelope. Falls back to the raw result for tools that don't provide
 * `structuredContent`.
 */
function unwrapMcpResult(result: unknown): unknown {
  if (
    result !== null &&
    typeof result === 'object' &&
    'structuredContent' in result
  ) {
    return (result as { structuredContent: unknown }).structuredContent;
  }
  return result;
}

/**
 * Translates this backend's ADK-derived tool-call/tool-result/content
 * outcomes (see trace.ts's `describeEvent`) into a real AG-UI event
 * stream for one agent run. One instance per `/chat` request.
 *
 * This emits `TOOL_CALL_START` (with `parentMessageId`) before the
 * assistant message has had a `TEXT_MESSAGE_START` — the "tool call,
 * then final answer" order. `@tanstack/ai@0.49.1`'s `StreamProcessor`
 * mishandled that and dropped the first `TEXT_MESSAGE_CONTENT` delta of
 * the text that followed; the frontend (and this translator) worked
 * around it with an empty `TEXT_MESSAGE_START`/`TEXT_MESSAGE_END` pair up
 * front. Fixed upstream in `@tanstack/ai@0.51.0`
 * (`handleTextMessageStartEvent` now resets the segment accumulator when
 * the message was already marked by a tool call), and payments-toolkit-
 * frontend now runs `0.52.0`, so the workaround is gone from both sides.
 */
export class AgUiTranslator {
  readonly assistantMessageId: string;
  private toolCallCounter = 0;
  private readonly toolCallIdByName = new Map<string, string>();

  constructor(
    private readonly threadId: string,
    private readonly runId: string,
  ) {
    this.assistantMessageId = `msg-${runId}-assistant`;
  }

  runStarted(): RunStartedEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId: this.runId,
    };
  }

  toolCall(
    name: string,
    args: Record<string, unknown> | undefined,
    id: string | undefined,
  ): [ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent] {
    const toolCallId = id ?? `call-${this.runId}-${this.toolCallCounter++}`;
    this.toolCallIdByName.set(name, toolCallId);
    return [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: name,
        parentMessageId: this.assistantMessageId,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify(args ?? {}),
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ];
  }

  /**
   * The tool-call id a result/widget event should carry — the id ADK gave
   * the call if present, else the one `toolCall()` minted for this name.
   */
  toolCallIdFor(name: string, id: string | undefined): string {
    return id ?? this.toolCallIdByName.get(name) ?? name;
  }

  toolResult(
    name: string,
    result: unknown,
    id: string | undefined,
  ): ToolCallResultEvent {
    const toolCallId = this.toolCallIdFor(name, id);
    return {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `tool-${toolCallId}`,
      toolCallId,
      role: 'tool',
      content: JSON.stringify(unwrapMcpResult(result)),
    };
  }

  /**
   * Forwards an MCP Apps widget resource for a tool call as an AG-UI
   * `CUSTOM` event. `@tanstack/ai`'s `StreamProcessor` recognises
   * `name: 'ui-resource'` and reconciles `value` into a `ui-resource`
   * message part on the assistant message, matched to the tool call by
   * `toolCallId` — so this must be emitted *after* the corresponding
   * `TOOL_CALL_START` (which registers that id). See
   * payments-toolkit-frontend's `McpAppView.vue` for the render side.
   */
  uiResource(
    name: string,
    id: string | undefined,
    payload: UiResourcePayload,
  ): CustomEvent {
    return {
      type: EventType.CUSTOM,
      name: 'ui-resource',
      value: {
        resource: payload.resource,
        toolCallId: this.toolCallIdFor(name, id),
        toolName: payload.toolName,
      },
    };
  }

  content(
    text: string,
  ): [TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent] {
    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.assistantMessageId,
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.assistantMessageId,
        delta: text,
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: this.assistantMessageId },
    ];
  }

  runError(message: string): RunErrorEvent {
    return { type: EventType.RUN_ERROR, message };
  }

  runFinished(): RunFinishedEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
    };
  }
}
