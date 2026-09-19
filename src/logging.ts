import { randomUUID } from 'node:crypto';
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

// Structured JSON to stdout — same "app emits a stream, the environment
// routes it" convention as payments-toolkit-mcp's own logger, and what lets
// Railway capture/store this audit trail for both the CLI and the
// long-lived HTTP server without a file/volume to manage. Always plain
// JSON, regardless of NODE_ENV, rather than a pretty-printed dev transport:
// pipe it through `pino-pretty` (installed as a dev dependency) to view it
// by hand, e.g. `pnpm start "..." | pnpm exec pino-pretty`. Not read by the
// eval script, which captures its trace in-process off the runner's event
// stream directly (see eval/run-eval.ts) and never touches this log.
const logger = pino({ level });

/**
 * A logger scoped to one CLI invocation (one `pnpm start` call), so log
 * lines from concurrent or historical runs in the same log file can be
 * told apart.
 */
export function createRunLogger(): pino.Logger {
  return logger.child({ invocationId: randomUUID() });
}

// All current tool arguments are sensitive payment identifiers (card
// numbers, IBANs), so every string is masked to its last 4 characters
// rather than maintaining a per-field allowlist of sensitive names — same
// approach as payments-toolkit-mcp's own tool-call logging. Recurses into
// arrays and nested objects so a masked string can't slip through inside a
// structured payload.
export function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskSensitive(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, maskDeep(v)]),
    );
  }
  return value;
}

export function maskArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return maskDeep(args) as Record<string, unknown>;
}

function maskSensitive(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

export function logToolCall(
  log: pino.Logger,
  name: string,
  args: Record<string, unknown> | undefined,
): void {
  log.info({ target: name, args: maskArgs(args ?? {}) }, 'tool call started');
}

// `detect_card_type` echoes the full card number back in its result, so the
// result is masked with the same blanket rule as the arguments — every
// string down to its last 4 characters. This trades away log readability of
// the non-sensitive fields (network, country) for not maintaining an
// allowlist; nothing reads this file programmatically.
export function logToolResult(
  log: pino.Logger,
  name: string,
  result: unknown,
): void {
  log.info({ target: name, result: maskDeep(result) }, 'tool call finished');
}
