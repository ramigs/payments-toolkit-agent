import type { EventOutcome } from '../src/trace.js';

export type ToolCallRecord = NonNullable<EventOutcome['toolCall']>;

export interface ResponseExpectation {
  matches?: RegExp;
  excludes?: RegExp;
}

export interface Scenario {
  id: string;
  description: string;
  prompt: string;
  /** Exact set of tool names expected to be called (order-independent), or 'none'. */
  expectedTools: string[] | 'none';
  /** Optional predicate over the actual captured calls, for checking argument construction. */
  expectedArgs?: (calls: ToolCallRecord[]) => boolean;
  /** Optional heuristic check on the agent's final natural-language response. */
  expectedResponse?: ResponseExpectation;
}

export function calledWith(
  calls: ToolCallRecord[],
  name: string,
  argsPredicate: (args: Record<string, unknown> | undefined) => boolean,
): boolean {
  return calls.some((call) => call.name === name && argsPredicate(call.args));
}

export const scenarios: Scenario[] = [
  {
    id: 'card-check-both-tools',
    description:
      'unqualified "check this card" implies both Luhn and network checks',
    prompt: 'Check this card: 4111111111111111',
    expectedTools: ['validate_card_number', 'detect_card_type'],
    expectedResponse: {
      matches: /visa/i,
      excludes: /invalid|not\s+(a\s+)?valid/i,
    },
  },
  {
    id: 'card-valid-reports-brand',
    description:
      'a valid card number should also get a network lookup, with the brand named in the answer',
    prompt: 'Is 4111111111111111 a valid card number?',
    expectedTools: ['validate_card_number', 'detect_card_type'],
    expectedResponse: {
      matches: /visa/i,
      excludes: /invalid|not\s+(a\s+)?valid/i,
    },
  },
  {
    id: 'card-network-only',
    description:
      'a prompt that only asks about the network should not also call validate_card_number',
    prompt: 'What card network is 4111111111111111 from?',
    expectedTools: ['detect_card_type'],
    expectedResponse: {
      matches: /visa/i,
    },
  },
  {
    id: 'card-args-normalized',
    description:
      'dashes must be stripped from the card number before the tool call',
    // Real assertion here is arg normalization (dashes stripped before
    // the call), checked on the expectedArgs axis. 4111...1111 is a
    // valid Visa, so a validity question now also calls detect_card_type
    // (see card-valid-reports-brand); expectedTools reflects that.
    prompt: 'Is 4111-1111-1111-1111 a valid card number?',
    expectedTools: ['validate_card_number', 'detect_card_type'],
    expectedArgs: (calls) =>
      calledWith(
        calls,
        'validate_card_number',
        (args) => args?.cardNumber === '4111111111111111',
      ),
  },
  {
    id: 'card-invalid-fidelity',
    description:
      'a failed Luhn check must be relayed as invalid, not softened — and an invalid number gets no network lookup or brand mention',
    prompt: 'Is 4111111111111112 a valid card number?',
    expectedTools: ['validate_card_number'],
    expectedResponse: {
      matches: /invalid|not\s+(a\s+)?valid|fails/i,
      excludes:
        /\bis valid\b|visa|mastercard|amex|american express|discover|diners|jcb/i,
    },
  },
  {
    // Exploratory: cardNumberSchema on the MCP server requires digits only
    // (8-19 chars), so "XY" surviving dash-stripping should make the tool
    // call itself fail. Expectation may need adjusting after the first
    // real run, since it's untested how the agent behaves when a tool
    // call errors mid-turn.
    id: 'card-malformed-tool-error',
    description:
      'non-digit characters should surface as a tool error, not a fabricated verdict',
    prompt: 'Is 4111-11XY-1111-1111 a valid card number?',
    expectedTools: ['validate_card_number'],
    expectedResponse: {
      excludes: /\bis valid\b|\bpasses\b/i,
    },
  },
  {
    id: 'iban-valid',
    description: 'a well-known valid German IBAN should pass',
    prompt: 'Is DE89370400440532013000 a valid IBAN?',
    expectedTools: ['validate_iban'],
    expectedArgs: (calls) =>
      calledWith(
        calls,
        'validate_iban',
        (args) => args?.iban === 'DE89370400440532013000',
      ),
    expectedResponse: {
      matches: /valid/i,
      excludes: /invalid|not\s+(a\s+)?valid/i,
    },
  },
  {
    id: 'iban-invalid-fidelity',
    description: 'a broken checksum must be relayed as invalid, not softened',
    prompt: 'Is DE89370400440532013001 a valid IBAN?',
    expectedTools: ['validate_iban'],
    expectedResponse: {
      matches: /invalid|not\s+(a\s+)?valid/i,
      excludes: /\bis valid\b/i,
    },
  },
  {
    id: 'out-of-scope-obvious',
    description:
      'a clearly unrelated request should be declined without any tool call',
    prompt: "What's the weather today?",
    expectedTools: 'none',
    expectedResponse: {
      matches: /card|iban|payment|scope/i,
    },
  },
  {
    id: 'out-of-scope-adjacent',
    description:
      'a payments-flavored but out-of-scope request should still be declined, not improvised',
    prompt: 'Can you process a refund for this transaction?',
    expectedTools: 'none',
    expectedResponse: {
      matches: /card|iban|payment|scope|valid/i,
    },
  },
  {
    id: 'ambiguous-clarify',
    description:
      'input too short/ambiguous for either tool should prompt a clarifying question, not a guess',
    prompt: 'Is 123456 valid?',
    expectedTools: 'none',
    expectedResponse: {
      matches: /\?/,
      excludes: /\bis valid\b/i,
    },
  },
  {
    id: 'multi-entity',
    description:
      'a prompt naming a valid card and an IBAN should trigger card validation + network lookup and IBAN validation, addressing both in the response',
    prompt:
      'Is 5500005555555559 a valid card number, and is GB29NWBK60161331926819 a valid IBAN?',
    expectedTools: ['validate_card_number', 'detect_card_type', 'validate_iban'],
    expectedResponse: {
      matches: /mastercard/i,
    },
  },
];
