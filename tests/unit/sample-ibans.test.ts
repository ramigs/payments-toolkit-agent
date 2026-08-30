import { describe, it, expect } from 'vitest';
import {
  SAMPLE_IBAN_POOL,
  pickSampleIbans,
  type SampleIbanCountry,
} from '../../src/sample-ibans.js';
import {
  createChatApp,
  type ChatMcpUi,
  type ChatRunner,
} from '../../src/app.js';

/** ISO 7064 mod-97-10 — mirrors the checksum `validate_iban` enforces. */
function mod97Valid(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  const rearranged = s.slice(4) + s.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (ch) =>
    (ch.charCodeAt(0) - 55).toString(),
  );
  let rem = 0;
  for (const d of expanded) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

const ALL_CODES = Object.keys(SAMPLE_IBAN_POOL) as SampleIbanCountry[];

describe('SAMPLE_IBAN_POOL', () => {
  const entries = ALL_CODES.flatMap((code) =>
    SAMPLE_IBAN_POOL[code].ibans.map((iban) => [code, iban] as const),
  );

  it.each(entries)(
    '%s sample %s is well-formed and mod-97-valid',
    (code, iban) => {
      expect(iban).toMatch(/^[A-Z]{2}\d{2}[A-Z0-9]+$/);
      expect(iban.startsWith(code)).toBe(true);
      expect(mod97Valid(iban)).toBe(true);
    },
  );

  it('has a country name and at least one IBAN for every entry', () => {
    for (const code of ALL_CODES) {
      expect(SAMPLE_IBAN_POOL[code].country).toBeTruthy();
      expect(SAMPLE_IBAN_POOL[code].ibans.length).toBeGreaterThan(0);
    }
  });
});

describe('pickSampleIbans', () => {
  it('returns exactly one entry per country, in pool order', () => {
    const picked = pickSampleIbans();
    expect(picked.map((c) => c.countryCode)).toEqual(ALL_CODES);
  });

  it('only ever returns IBANs (and names) from the pool', () => {
    for (let i = 0; i < 50; i++) {
      for (const { countryCode, country, iban } of pickSampleIbans()) {
        expect(SAMPLE_IBAN_POOL[countryCode].country).toBe(country);
        expect(SAMPLE_IBAN_POOL[countryCode].ibans).toContain(iban);
      }
    }
  });
});

describe('GET /sample-ibans', () => {
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

  it('responds with one valid sample IBAN per country', async () => {
    const app = createChatApp({ runner, mcpUi: noUi });
    const res = await app.request('http://test/sample-ibans');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      countryCode: string;
      country: string;
      iban: string;
    }>;
    expect(body.map((c) => c.countryCode)).toEqual(ALL_CODES);
    for (const { countryCode, iban } of body) {
      expect(
        SAMPLE_IBAN_POOL[countryCode as SampleIbanCountry].ibans,
      ).toContain(iban);
    }
  });

  it('sets a permissive CORS header', async () => {
    const app = createChatApp({ runner, mcpUi: noUi });
    const res = await app.request('http://test/sample-ibans', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
