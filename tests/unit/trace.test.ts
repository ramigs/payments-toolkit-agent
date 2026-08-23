import { describe, it, expect } from 'vitest';
import { EventType } from '@google/adk';
import { describeEvent } from '../../src/trace.js';

describe('describeEvent', () => {
  it('describes a tool call event', () => {
    const outcome = describeEvent({
      type: EventType.TOOL_CALL,
      call: {
        name: 'validate_card_number',
        args: { cardNumber: '4111111111111111' },
      },
    });
    expect(outcome.consoleLines).toEqual([
      '\n[tool call] validate_card_number',
      '  args: {"cardNumber":"4111111111111111"}',
    ]);
    expect(outcome.toolCall).toEqual({
      name: 'validate_card_number',
      args: { cardNumber: '4111111111111111' },
    });
  });

  it('falls back to "unknown" when a tool call has no name', () => {
    const outcome = describeEvent({
      type: EventType.TOOL_CALL,
      call: { args: {} },
    });
    expect(outcome.toolCall?.name).toBe('unknown');
  });

  it('describes a tool result event', () => {
    const outcome = describeEvent({
      type: EventType.TOOL_RESULT,
      result: { name: 'validate_card_number', response: { valid: true } },
    });
    expect(outcome.consoleLines).toEqual([
      '[tool result] validate_card_number: {"valid":true}',
    ]);
    expect(outcome.toolResult).toEqual({
      name: 'validate_card_number',
      result: { valid: true },
    });
  });

  it('falls back to "unknown" when a tool result has no name', () => {
    const outcome = describeEvent({
      type: EventType.TOOL_RESULT,
      result: { response: {} },
    });
    expect(outcome.toolResult?.name).toBe('unknown');
  });

  it('accumulates content as a delta with no console output', () => {
    const outcome = describeEvent({
      type: EventType.CONTENT,
      content: 'Hello',
    });
    expect(outcome.consoleLines).toEqual([]);
    expect(outcome.contentDelta).toBe('Hello');
  });

  it('routes errors to stderr and marks the run as failed', () => {
    const outcome = describeEvent({
      type: EventType.ERROR,
      error: new Error('boom'),
    });
    expect(outcome.consoleLines).toEqual(['\n[error] boom']);
    expect(outcome.toStderr).toBe(true);
    expect(outcome.isError).toBe(true);
  });

  it('produces no output for event types outside the CLI trace', () => {
    const outcome = describeEvent({ type: EventType.FINISHED });
    expect(outcome.consoleLines).toEqual([]);
    expect(outcome.toolCall).toBeUndefined();
    expect(outcome.toolResult).toBeUndefined();
    expect(outcome.contentDelta).toBeUndefined();
    expect(outcome.isError).toBeUndefined();
  });
});
