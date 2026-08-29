import { describe, it, expect, vi } from 'vitest';
import type pino from 'pino';
import {
  createRunLogger,
  logToolCall,
  logToolResult,
  maskArgs,
} from '../../src/logging.js';

function fakeLogger(): { info: ReturnType<typeof vi.fn>; log: pino.Logger } {
  const info = vi.fn();
  return { info, log: { info } as unknown as pino.Logger };
}

describe('maskArgs', () => {
  it('masks a card number to its last 4 digits', () => {
    expect(maskArgs({ cardNumber: '4111111111111111' })).toEqual({
      cardNumber: '************1111',
    });
  });

  it('masks an IBAN to its last 4 characters', () => {
    expect(maskArgs({ iban: 'DE89370400440532013000' })).toEqual({
      iban: '******************3000',
    });
  });

  it('masks every string value when there are multiple args', () => {
    expect(
      maskArgs({ cardNumber: '4111111111111111', label: 'primary' }),
    ).toEqual({
      cardNumber: '************1111',
      label: '***mary',
    });
  });

  it('masks a value shorter than 4 characters entirely', () => {
    expect(maskArgs({ code: 'ab' })).toEqual({ code: '**' });
  });

  it('masks a value exactly 4 characters entirely', () => {
    expect(maskArgs({ code: 'ab12' })).toEqual({ code: '****' });
  });

  it('leaves non-string values untouched', () => {
    expect(maskArgs({ count: 3, valid: true, meta: null })).toEqual({
      count: 3,
      valid: true,
      meta: null,
    });
  });

  it('returns an empty object for empty args', () => {
    expect(maskArgs({})).toEqual({});
  });

  it('recurses into nested objects and arrays', () => {
    expect(
      maskArgs({
        cards: [{ cardNumber: '4111111111111111' }],
        meta: { note: 'primary', count: 2 },
      }),
    ).toEqual({
      cards: [{ cardNumber: '************1111' }],
      meta: { note: '***mary', count: 2 },
    });
  });
});

describe('logToolCall', () => {
  it('logs the tool name with masked args', () => {
    const { info, log } = fakeLogger();
    logToolCall(log, 'validate_card_number', {
      cardNumber: '4111111111111111',
    });
    expect(info).toHaveBeenCalledWith(
      {
        target: 'validate_card_number',
        args: { cardNumber: '************1111' },
      },
      'tool call started',
    );
  });

  it('defaults to an empty args object when none are given', () => {
    const { info, log } = fakeLogger();
    logToolCall(log, 'validate_iban', undefined);
    expect(info).toHaveBeenCalledWith(
      { target: 'validate_iban', args: {} },
      'tool call started',
    );
  });
});

describe('logToolResult', () => {
  it('leaves non-string result fields untouched', () => {
    const { info, log } = fakeLogger();
    logToolResult(log, 'validate_card_number', { valid: true });
    expect(info).toHaveBeenCalledWith(
      { target: 'validate_card_number', result: { valid: true } },
      'tool call finished',
    );
  });

  it('masks a card number echoed back in the result', () => {
    const { info, log } = fakeLogger();
    logToolResult(log, 'detect_card_type', {
      structuredContent: { network: 'Visa', cardNumber: '4111111111111111' },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            network: 'Visa',
            cardNumber: '4111111111111111',
          }),
        },
      ],
    });
    const [payload] = info.mock.calls[0] as [
      { result: { structuredContent: { cardNumber: string } } },
    ];
    expect(payload.result.structuredContent.cardNumber).toBe('************1111');
    expect(JSON.stringify(payload)).not.toContain('4111111111111111');
  });
});

describe('createRunLogger', () => {
  it('binds a unique invocationId to each run logger', () => {
    const idOf = (log: pino.Logger): unknown =>
      (log.bindings() as { invocationId?: string }).invocationId;
    const a = idOf(createRunLogger());
    const b = idOf(createRunLogger());
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});
