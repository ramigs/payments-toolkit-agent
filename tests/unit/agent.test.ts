import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMcpServerPath, buildAgent } from '../../src/agent.js';

const FAKE_SERVER_PATH = '/path/to/payments-toolkit-mcp/dist/index.js';

describe('getMcpServerPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured path', () => {
    vi.stubEnv('MCP_SERVER_PATH', FAKE_SERVER_PATH);
    expect(getMcpServerPath()).toBe(FAKE_SERVER_PATH);
  });

  it('throws when the env var is unset', () => {
    vi.stubEnv('MCP_SERVER_PATH', '');
    expect(() => getMcpServerPath()).toThrow('MCP_SERVER_PATH is not set.');
  });
});

describe('buildAgent', () => {
  it('wires the agent with the expected name, model, and tools', () => {
    const { agent, mcpToolset } = buildAgent(FAKE_SERVER_PATH);
    expect(agent.name).toBe('payments_toolkit_agent');
    expect(agent.model).toBe('gemini-3.5-flash-lite');
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0]).toBe(mcpToolset);
  });

  it('scopes the system instruction to payment-detail validation', () => {
    const { agent } = buildAgent(FAKE_SERVER_PATH);
    const instruction = agent.instruction as string;
    expect(instruction).toContain('validate_card_number');
    expect(instruction).toContain('detect_card_type');
    expect(instruction).toContain('validate_iban');
    expect(instruction).toContain('decline');
  });
});
