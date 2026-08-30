/**
 * A curated pool of valid example IBANs, grouped by country. These are the
 * canonical registry examples (ECBS / Wikipedia) plus a few well-known
 * bank test IBANs — every entry passes the ISO 7064 mod-97 check and the
 * country-specific length, so `validate_iban` agrees with the label here.
 *
 * Same trust model as `sample-cards.ts`: the list is taken as-is, nothing
 * round-trips through the MCP server. `tests/unit/sample-ibans.test.ts`
 * re-checks the mod-97 remainder on every entry.
 *
 * They are not real accounts and authorize nothing.
 */
export const SAMPLE_IBAN_POOL = {
  DE: {
    country: 'Germany',
    ibans: [
      'DE89370400440532013000',
      'DE75512108001245126199',
      'DE12500105170648489890',
    ],
  },
  GB: {
    country: 'United Kingdom',
    ibans: [
      'GB29NWBK60161331926819',
      'GB33BUKB20201555555555',
      'GB94BARC10201530093459',
    ],
  },
  FR: {
    country: 'France',
    ibans: ['FR1420041010050500013M02606', 'FR7630006000011234567890189'],
  },
  ES: {
    country: 'Spain',
    ibans: ['ES9121000418450200051332', 'ES7921000813610123456789'],
  },
  NL: {
    country: 'Netherlands',
    ibans: ['NL91ABNA0417164300', 'NL02ABNA0123456789'],
  },
  BE: {
    country: 'Belgium',
    ibans: ['BE68539007547034', 'BE71096123456769'],
  },
  CH: {
    country: 'Switzerland',
    ibans: ['CH9300762011623852957', 'CH5604835012345678009'],
  },
  IT: {
    country: 'Italy',
    ibans: ['IT60X0542811101000000123456'],
  },
} as const satisfies Record<
  string,
  { country: string; ibans: readonly string[] }
>;

export type SampleIbanCountry = keyof typeof SAMPLE_IBAN_POOL;

export interface SampleIban {
  countryCode: SampleIbanCountry;
  country: string;
  iban: string;
}

/**
 * One randomly chosen valid IBAN per country, in the pool's declared order.
 * Fresh selection on every call — the frontend hits this to populate a
 * "try a sample" picker without needing its own list of valid IBANs.
 */
export function pickSampleIbans(): SampleIban[] {
  return (Object.keys(SAMPLE_IBAN_POOL) as SampleIbanCountry[]).map(
    (countryCode) => {
      const { country, ibans } = SAMPLE_IBAN_POOL[countryCode];
      return {
        countryCode,
        country,
        iban: ibans[Math.floor(Math.random() * ibans.length)],
      };
    },
  );
}
