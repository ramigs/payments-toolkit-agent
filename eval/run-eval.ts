import 'dotenv/config';
import { InMemoryRunner, toStructuredEvents } from '@google/adk';
import { buildAgent, getMcpServerPath } from '../src/agent.js';
import { describeEvent } from '../src/trace.js';
import { scenarios, type Scenario, type ToolCallRecord } from './scenarios.js';

type AxisStatus = 'pass' | 'fail' | 'n/a';

interface AxisResult {
  status: AxisStatus;
  detail?: string;
}

interface ScenarioRun {
  toolCalls: ToolCallRecord[];
  finalText: string;
}

async function runScenario(
  runner: InMemoryRunner,
  scenario: Scenario,
): Promise<ScenarioRun> {
  const toolCalls: ToolCallRecord[] = [];
  let finalText = '';

  for await (const event of runner.runEphemeral({
    userId: 'eval-user',
    newMessage: { parts: [{ text: scenario.prompt }] },
  })) {
    for (const structured of toStructuredEvents(event)) {
      const outcome = describeEvent(structured);
      if (outcome.toolCall) {
        toolCalls.push(outcome.toolCall);
      }
      if (outcome.contentDelta) {
        finalText += outcome.contentDelta;
      }
    }
  }

  return { toolCalls, finalText };
}

function gradeTools(scenario: Scenario, calls: ToolCallRecord[]): AxisResult {
  const actual = calls.map((call) => call.name).sort();
  const expected =
    scenario.expectedTools === 'none' ? [] : [...scenario.expectedTools].sort();
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return pass
    ? { status: 'pass' }
    : {
        status: 'fail',
        detail: `expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
      };
}

function gradeArgs(scenario: Scenario, calls: ToolCallRecord[]): AxisResult {
  if (!scenario.expectedArgs) return { status: 'n/a' };
  return scenario.expectedArgs(calls)
    ? { status: 'pass' }
    : { status: 'fail', detail: 'captured tool call args did not match' };
}

function gradeResponse(scenario: Scenario, finalText: string): AxisResult {
  const expectation = scenario.expectedResponse;
  if (!expectation) return { status: 'n/a' };

  if (expectation.matches && !expectation.matches.test(finalText)) {
    return {
      status: 'fail',
      detail: `expected response to match ${expectation.matches}`,
    };
  }
  if (expectation.excludes && expectation.excludes.test(finalText)) {
    return {
      status: 'fail',
      detail: `expected response not to match ${expectation.excludes}`,
    };
  }
  return { status: 'pass' };
}

function formatAxis(result: AxisResult): string {
  if (result.status !== 'fail') return result.status;
  return result.detail ? `fail — ${result.detail}` : 'fail';
}

async function main(): Promise<void> {
  const mcpServerPath = getMcpServerPath();
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Copy .env.example to .env and set it.',
    );
  }

  const { agent, mcpToolset } = buildAgent(mcpServerPath);
  const runner = new InMemoryRunner({
    agent,
    appName: 'payments-toolkit-agent-eval',
  });

  const requestedIds = new Set(process.argv.slice(2));
  const selected =
    requestedIds.size > 0
      ? scenarios.filter((scenario) => requestedIds.has(scenario.id))
      : scenarios;

  let failures = 0;

  try {
    for (const scenario of selected) {
      const { toolCalls, finalText } = await runScenario(runner, scenario);

      const tools = gradeTools(scenario, toolCalls);
      const args = gradeArgs(scenario, toolCalls);
      const response = gradeResponse(scenario, finalText);
      const overall = [tools, args, response].every((axis) => axis.status !== 'fail');
      if (!overall) failures += 1;

      console.log(
        `\n[${overall ? 'PASS' : 'FAIL'}] ${scenario.id} — ${scenario.description}`,
      );
      console.log(`  tools:    ${formatAxis(tools)}`);
      console.log(`  args:     ${formatAxis(args)}`);
      console.log(`  response: ${formatAxis(response)}`);
    }
  } finally {
    await mcpToolset.close();
  }

  console.log(`\n${selected.length - failures}/${selected.length} scenarios passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
