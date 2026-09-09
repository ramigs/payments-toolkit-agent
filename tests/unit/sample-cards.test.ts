import { describe, it, expect } from 'vitest';
import {
  SAMPLE_CARD_POOL,
  pickSampleCards,
  type SampleCardType,
} from '../../src/sample-cards.js';
import {
  createChatApp,
  type ChatMcpUi,
  type ChatRunner,
} from '../../src/app.js';
import type { TokenVerifier } from '../../src/auth.js';

/** Auth stub: accept every request. Real JWKS verification is covered in app.test.ts. */
const allowAll: TokenVerifier = async () => ({ userId: 'test-user' });

/** Standard Luhn checksum — mirrors what `validate_card_number` enforces. */
function luhnValid(pan: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let digit = pan.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const ALL_TYPES = Object.keys(SAMPLE_CARD_POOL) as SampleCardType[];

describe('SAMPLE_CARD_POOL', () => {
  const entries = ALL_TYPES.flatMap((type) =>
    SAMPLE_CARD_POOL[type].map((pan) => [type, pan] as const),
  );

  it.each(entries)(
    '%s sample %s is all digits and Luhn-valid',
    (_type, pan) => {
      expect(pan).toMatch(/^\d+$/);
      expect(luhnValid(pan)).toBe(true);
    },
  );

  it('has at least one number for every network', () => {
    for (const type of ALL_TYPES) {
      expect(SAMPLE_CARD_POOL[type].length).toBeGreaterThan(0);
    }
  });
});

describe('pickSampleCards', () => {
  it('returns exactly one entry per network, in pool order', () => {
    const picked = pickSampleCards();
    expect(picked.map((c) => c.cardType)).toEqual(ALL_TYPES);
  });

  it('only ever returns numbers from the pool', () => {
    for (let i = 0; i < 50; i++) {
      for (const { cardType, cardNumber } of pickSampleCards()) {
        expect(SAMPLE_CARD_POOL[cardType]).toContain(cardNumber);
      }
    }
  });
});

describe('GET /sample-cards', () => {
  const noUi: ChatMcpUi = { forTool: async () => undefined };
  const runner = {
    sessionService: {
      async createSession() {
        return { id: 's' };
      },
      async deleteSession() {},
    },
    // eslint-disable-next-line require-yield
    async *runAsync() {
      return;
    },
  } as unknown as ChatRunner;

  it('responds with one valid sample card per network', async () => {
    const app = createChatApp({ runner, mcpUi: noUi, verifyToken: allowAll });
    const res = await app.request('http://test/sample-cards');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      cardType: string;
      cardNumber: string;
    }>;
    expect(body.map((c) => c.cardType)).toEqual(ALL_TYPES);
    for (const { cardType, cardNumber } of body) {
      expect(SAMPLE_CARD_POOL[cardType as SampleCardType]).toContain(
        cardNumber,
      );
    }
  });

  it('sets a permissive CORS header', async () => {
    const app = createChatApp({ runner, mcpUi: noUi, verifyToken: allowAll });
    const res = await app.request('http://test/sample-cards', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers the CORS preflight the bearer token triggers (not a 404)', async () => {
    const app = createChatApp({ runner, mcpUi: noUi, verifyToken: allowAll });
    const res = await app.request('http://test/sample-cards', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
  });
});
