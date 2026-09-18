import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getMcpServerUrl,
  getMcpAuthToken,
  buildAgent,
} from '../../src/agent.js';

const FAKE_SERVER_URL = 'http://payments-toolkit-mcp.railway.internal:3000/mcp';
const FAKE_AUTH_TOKEN = 'test-token';
const FAKE_CONNECTION = {
  mcpServerUrl: FAKE_SERVER_URL,
  mcpAuthToken: FAKE_AUTH_TOKEN,
};

describe('getMcpServerUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured URL', () => {
    vi.stubEnv('MCP_SERVER_URL', FAKE_SERVER_URL);
    expect(getMcpServerUrl()).toBe(FAKE_SERVER_URL);
  });

  it('throws when the env var is unset', () => {
    vi.stubEnv('MCP_SERVER_URL', '');
    expect(() => getMcpServerUrl()).toThrow('MCP_SERVER_URL is not set.');
  });
});

describe('getMcpAuthToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured token', () => {
    vi.stubEnv('MCP_AUTH_TOKEN', FAKE_AUTH_TOKEN);
    expect(getMcpAuthToken()).toBe(FAKE_AUTH_TOKEN);
  });

  it('throws when the env var is unset', () => {
    vi.stubEnv('MCP_AUTH_TOKEN', '');
    expect(() => getMcpAuthToken()).toThrow('MCP_AUTH_TOKEN is not set.');
  });
});

describe('buildAgent', () => {
  it('wires the agent with the expected name, model, and tools', () => {
    const { agent, mcpToolset } = buildAgent(FAKE_CONNECTION);
    expect(agent.name).toBe('payments_toolkit_agent');
    expect(agent.model).toBe('gemini-3.5-flash-lite');
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0]).toBe(mcpToolset);
  });

  it('scopes the system instruction to payment-detail validation', () => {
    const { agent } = buildAgent(FAKE_CONNECTION);
    const instruction = agent.instruction as string;
    expect(instruction).toContain('validate_card_number');
    expect(instruction).toContain('detect_card_type');
    expect(instruction).toContain('validate_iban');
    expect(instruction).toContain('decline');
  });
});
