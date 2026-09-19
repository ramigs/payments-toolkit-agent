import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LlmAgent, MCPToolset, getLogger, setLogger } from '@google/adk';

// @google/adk@2.0.0's MCPSessionManager unconditionally logs every MCP
// transport `onerror` at `error` level (mcp_session_manager.js:
// `transport.onerror = logTransportError`). Since it opens and closes a
// fresh StreamableHTTPClientTransport session per tool call, closing one
// aborts its in-flight requests — and the MCP SDK reports that
// *intentional* abort through the same `onerror` callback it'd use for a
// real network disconnect (streamableHttp.js has several `onerror` call
// sites; some wrap it as "SSE stream disconnected: AbortError: This
// operation was aborted", others just pass the bare AbortError through as
// "This operation was aborted" — both observed in practice, hence matching
// on the message text common to both rather than one exact phrasing). The
// result: a scary red "MCP transport error: ..." on every single tool call,
// and on every `/chat/:runId/cancel` too, even though nothing failed.
// Filtered out here by message pattern rather than passed through — any
// other ADK log, including a genuinely different transport error, still
// goes through unchanged.
const BENIGN_MCP_CLOSE_ABORT = /This operation was aborted/;
const defaultAdkLogger = getLogger();
setLogger({
  setLogLevel: (level) => defaultAdkLogger.setLogLevel(level),
  log: (level, ...args) => defaultAdkLogger.log(level, ...args),
  debug: (...args) => defaultAdkLogger.debug(...args),
  info: (...args) => defaultAdkLogger.info(...args),
  warn: (...args) => defaultAdkLogger.warn(...args),
  error: (...args) => {
    const isBenignCloseAbort = args.some(
      (arg) => typeof arg === 'string' && BENIGN_MCP_CLOSE_ABORT.test(arg),
    );
    if (!isBenignCloseAbort) defaultAdkLogger.error(...args);
  },
});

const MCP_SERVER_NAME = 'payments-toolkit-mcp';

const TOOL_NAMES = [
  'validate_card_number',
  'detect_card_type',
  'validate_iban',
] as const;

const RESOURCE_NAMES = ['card_networks'] as const;

const PROMPT_NAMES = ['check_payment_details'] as const;

export const ADK_MODEL = 'gemini-3.5-flash-lite';

const SYSTEM_PROMPT = `You are a narrow payments-validation assistant. Your only job is to help
users validate payment details using the tools available to you:

- validate_card_number: Luhn checksum validation for a card number
- detect_card_type: identify the card network (Visa, Mastercard, American
  Express, Discover, Diners Club, JCB) from a card number's IIN/BIN prefix
- validate_iban: format, country-specific length, and checksum validation
  for an IBAN

Rules:
- Always call the relevant tool(s) to answer — never compute or guess a
  validation result yourself.
- For any question about a card number — whether it's valid, what
  network it's on, or both — call validate_card_number first. Only if
  the number is valid, then also call detect_card_type and name the
  card network alongside the verdict. If the number is invalid, say so
  and stop — don't call detect_card_type, and don't name a card network,
  even when the network is all the user asked for.
- Otherwise, call only the tool(s) needed to answer what was asked.
- Strip spaces/dashes from card numbers before passing them to a tool.
- If the user doesn't say whether a value is a card number or an IBAN,
  and the value itself doesn't clearly indicate one (e.g. it's too short
  to be either — a card number is 8-19 digits, an IBAN starts with 2
  letters and is at least ~15 characters), don't guess which tool to
  call — ask which one they mean.
- Report each tool's result accurately and directly — never soften,
  hedge, or override an "invalid" result.
- When reporting an IBAN result, refer to the country by its name with
  the code after it in parentheses, e.g. "Germany (DE)" — write it into
  a sentence, not as a bare "Country: DE" field.
- If asked about anything unrelated to validating a card number, card
  type, or IBAN, politely decline and explain that you're scoped to
  payment-detail validation only.`;

function warnIfMissing(
  label: string,
  expectedNames: readonly string[],
  actual: readonly { name: string }[],
): void {
  const missing = expectedNames.filter(
    (name) => !actual.some((item) => item.name === name),
  );
  if (missing.length > 0) {
    console.error(
      `[boot] WARNING: expected ${label} not found on server: ${missing.join(', ')}`,
    );
  }
}

export function getMcpServerUrl(): string {
  const url = process.env.MCP_SERVER_URL;
  if (!url) {
    throw new Error('MCP_SERVER_URL is not set.');
  }
  return url;
}

export function getMcpAuthToken(): string {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    throw new Error('MCP_AUTH_TOKEN is not set.');
  }
  return token;
}

export interface McpConnectionConfig {
  mcpServerUrl: string;
  mcpAuthToken: string;
}

export function buildAgent(config: McpConnectionConfig): {
  agent: LlmAgent;
  mcpToolset: MCPToolset;
} {
  const mcpToolset = new MCPToolset(
    {
      type: 'StreamableHTTPConnectionParams',
      url: config.mcpServerUrl,
      transportOptions: {
        requestInit: {
          headers: { Authorization: `Bearer ${config.mcpAuthToken}` },
        },
      },
    },
    [...TOOL_NAMES],
  );

  const agent = new LlmAgent({
    name: 'payments_toolkit_agent',
    model: ADK_MODEL,
    instruction: SYSTEM_PROMPT,
    tools: [mcpToolset],
  });

  return { agent, mcpToolset };
}

/**
 * Lists the MCP server's tools/resources/prompts over an already-connected
 * client, logs the discovered surface, and warns if anything this agent
 * expects is missing. Shared by the CLI's standalone boot check
 * (`discoverMcpServer`) and the HTTP server's persistent MCP-UI client, so
 * the HTTP path doesn't open a second throwaway connection just to verify.
 */
export async function verifyMcpServer(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();

  console.log(
    `[boot] connected to ${MCP_SERVER_NAME}: tools=[${tools.map((t) => t.name).join(', ')}] ` +
      `resources=[${resources.map((r) => r.name).join(', ')}] ` +
      `prompts=[${prompts.map((p) => p.name).join(', ')}]`,
  );

  warnIfMissing('tools', TOOL_NAMES, tools);
  warnIfMissing('resources', RESOURCE_NAMES, resources);
  warnIfMissing('prompts', PROMPT_NAMES, prompts);
}

/**
 * Opens a throwaway MCP connection (independent of the ADK agent's own) to
 * run `verifyMcpServer` once at boot, then closes it. Used by the CLI; the
 * HTTP server runs the same check against its persistent MCP-UI client
 * instead of opening this extra connection.
 */
export async function discoverMcpServer(
  config: McpConnectionConfig,
): Promise<void> {
  const client = new Client({
    name: 'payments-toolkit-agent-boot-check',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(config.mcpServerUrl),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${config.mcpAuthToken}` },
      },
    },
  );

  try {
    await client.connect(transport);
    await verifyMcpServer(client);
  } finally {
    await client.close();
  }
}
