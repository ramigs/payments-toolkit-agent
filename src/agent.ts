import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export const MCP_SERVER_NAME = "payments-toolkit-mcp";

const TOOL_NAMES = [
  "validate_card_number",
  "detect_card_type",
  "validate_iban",
] as const;

const RESOURCE_NAMES = ["card_networks"] as const;

const PROMPT_NAMES = ["check_payment_details"] as const;

export const QUALIFIED_TOOL_NAMES = TOOL_NAMES.map(
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
);

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
- Strip spaces/dashes from card numbers before passing them to a tool.
- If the input is ambiguous or clearly malformed in a way the tools can't
  resolve (e.g. it's not clear what the user is even asking to validate),
  ask a clarifying question instead of guessing.
- Report each tool's result accurately and directly — never soften,
  hedge, or override an "invalid" result.
- If asked about anything unrelated to validating a card number, card
  type, or IBAN, politely decline and explain that you're scoped to
  payment-detail validation only.`;

function warnIfMissing(
  label: string,
  expectedNames: readonly string[],
  actual: readonly { name: string }[],
): void {
  const missing = expectedNames.filter((name) => !actual.some((item) => item.name === name));
  if (missing.length > 0) {
    console.error(`[boot] WARNING: expected ${label} not found on server: ${missing.join(", ")}`);
  }
}

export function getMcpServerPath(): string {
  const path = process.env.MCP_SERVER_PATH;
  if (!path) {
    throw new Error("MCP_SERVER_PATH is not set.");
  }
  return path;
}

export function buildAgentOptions(mcpServerPath: string): Options {
  return {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: "node",
        args: [mcpServerPath],
      },
    },
    tools: QUALIFIED_TOOL_NAMES,
    allowedTools: QUALIFIED_TOOL_NAMES,
  };
}

/**
 * Connects to the MCP server directly (independent of the agent SDK's own
 * connection) to confirm it exposes exactly what this agent expects, and
 * logs what was discovered. Run once at boot as a sanity check.
 */
export async function discoverMcpServer(mcpServerPath: string): Promise<void> {
  const client = new Client({
    name: "payments-toolkit-agent-boot-check",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpServerPath],
  });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const { prompts } = await client.listPrompts();

    console.error(
      `[boot] connected to ${MCP_SERVER_NAME}: tools=[${tools.map((t) => t.name).join(", ")}] ` +
        `resources=[${resources.map((r) => r.name).join(", ")}] ` +
        `prompts=[${prompts.map((p) => p.name).join(", ")}]`,
    );

    warnIfMissing("tools", TOOL_NAMES, tools);
    warnIfMissing("resources", RESOURCE_NAMES, resources);
    warnIfMissing("prompts", PROMPT_NAMES, prompts);
  } finally {
    await client.close();
  }
}
