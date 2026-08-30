/**
 * A curated pool of well-known, publicly documented test card numbers, one
 * set per network the toolkit recognizes (the same six `detect_card_type`
 * names: Visa, Mastercard, American Express, Discover, Diners Club, JCB).
 *
 * These are the standard test PANs published by payment processors (Stripe,
 * Adyen, PayPal, …). Every entry passes the Luhn checksum and sits on a real
 * IIN range for its network, so `validate_card_number` and `detect_card_type`
 * agree with the label here — but nothing round-trips through the MCP server:
 * this list is trusted as-is (see `tests/unit/sample-cards.test.ts`, which
 * re-checks the Luhn digit on every entry).
 *
 * They are not real accounts and never authorize a payment.
 */
export const SAMPLE_CARD_POOL = {
  Visa: [
    '4111111111111111',
    '4012888888881881',
    '4242424242424242',
    '4000056655665556',
  ],
  Mastercard: [
    '5555555555554444',
    '5105105105105100',
    '2223003122003222',
    '5454545454545454',
  ],
  'American Express': ['378282246310005', '371449635398431', '374245455400126'],
  Discover: ['6011111111111117', '6011000990139424', '6011981111111113'],
  'Diners Club': ['30569309025904', '38520000023237', '36227206271667'],
  JCB: ['3530111333300000', '3566002020360505', '3569990010095841'],
} as const satisfies Record<string, readonly string[]>;

export type SampleCardType = keyof typeof SAMPLE_CARD_POOL;

export interface SampleCard {
  cardType: SampleCardType;
  cardNumber: string;
}

/**
 * One randomly chosen test card per network, in the pool's declared order.
 * Fresh selection on every call — the frontend hits this to populate a
 * "try a sample" picker without needing its own list of valid numbers.
 */
export function pickSampleCards(): SampleCard[] {
  return (Object.keys(SAMPLE_CARD_POOL) as SampleCardType[]).map((cardType) => {
    const numbers = SAMPLE_CARD_POOL[cardType];
    return {
      cardType,
      cardNumber: numbers[Math.floor(Math.random() * numbers.length)],
    };
  });
}
