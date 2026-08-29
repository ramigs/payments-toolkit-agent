import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const level = process.env.LOG_LEVEL ?? 'info';

// Unlike the MCP server's logger (stderr, pretty-printed in dev for a human
// watching the terminal), this one is read back by the eval script — so it
// always writes plain JSON lines to a dedicated file, regardless of
// NODE_ENV. Pipe it through `pino-pretty` (installed as a dev dependency)
// to view it by hand: `tail -f logs/agent.log | pnpm exec pino-pretty`.
const logger = pino({ level }, pino.destination(LOG_FILE));

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
