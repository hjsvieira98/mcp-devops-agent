import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

import { buildSystemPrompt } from '../agent/system-prompt.js';
import { runAgent } from '../agent/loop.js';
import { readToolText, toolFromMcp } from '../agent/mcp.js';
import type { LanguageModel } from '../agent/types.js';
import { MemoryGitHub } from '../github/memory.js';
import { createDevOpsServer } from '../server/create-server.js';
import type { EvalScenario } from './scenarios.js';

export type ScenarioReport = {
  id: string;
  title: string;
  passed: boolean;
  failures: string[];
};

export async function runScenario(scenario: EvalScenario): Promise<ScenarioReport> {
  const github = new MemoryGitHub(structuredClone(scenario.world));
  const server = createDevOpsServer({
    github,
    repositories: scenario.repositories,
    version: '0.0.0-eval',
    now: () => new Date(scenario.now),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'eval-harness', version: '0.0.0' });
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => toolFromMcp(tool));
    const result = await runAgent({
      model: replayModel(scenario),
      tools,
      system: buildSystemPrompt(scenario.repositories),
      task: scenario.task,
      maxSteps: scenario.maxSteps,
      confirmWrite: async () => scenario.confirmWrites,
      execute: async (call) => {
        const toolResult = await client.callTool({ name: call.name, arguments: call.arguments });
        return readToolText(toolResult);
      },
    });

    const failures: string[] = [];
    const executed = result.toolCalls
      .filter((call) => call.executed)
      .map((call) => ({ name: call.name, arguments: call.arguments }));
    if (!sameCalls(executed, scenario.expectedExecuted)) {
      failures.push(
        `executed tools\n  actual:   ${JSON.stringify(executed)}\n  expected: ${JSON.stringify(scenario.expectedExecuted)}`,
      );
    }
    for (const name of scenario.forbiddenExecuted) {
      if (result.toolCalls.some((call) => call.executed && call.name === name)) {
        failures.push(`executed forbidden tool ${name}`);
      }
    }
    if (result.stoppedReason !== scenario.stoppedReason) {
      failures.push(
        `stoppedReason was ${result.stoppedReason}, expected ${scenario.stoppedReason}`,
      );
    }
    for (const phrase of scenario.answerMustInclude) {
      if (!result.text.includes(phrase)) {
        failures.push(`final answer missing "${phrase}". Answer was:\n${result.text}`);
      }
    }
    const created = github.calls.some((call) => call.method === 'createIssue');
    if (scenario.forbidGitHubCreate && created) {
      failures.push('GitHub createIssue was called');
    }
    if (!scenario.forbidGitHubCreate && !created) {
      failures.push('GitHub createIssue was not called');
    }
    return { id: scenario.id, title: scenario.title, passed: failures.length === 0, failures };
  } finally {
    await client.close();
    await server.close();
  }
}

export async function runScenarios(scenarios: readonly EvalScenario[]): Promise<ScenarioReport[]> {
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) reports.push(await runScenario(scenario));
  return reports;
}

export function formatReport(reports: readonly ScenarioReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`${report.passed ? 'PASS' : 'FAIL'}  ${report.id}  ${report.title}`);
    for (const failure of report.failures) {
      lines.push(`  ${failure.replaceAll('\n', '\n  ')}`);
    }
  }
  const failed = reports.filter((report) => !report.passed).length;
  lines.push(`${reports.length - failed}/${reports.length} scenarios passed`);
  return lines.join('\n');
}

function replayModel(scenario: EvalScenario): LanguageModel {
  let index = 0;
  return {
    provider: 'replay',
    model: 'replay',
    complete({ messages, tools }) {
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join('\n');
      if (tools.length === 0 || index >= scenario.plannedCalls.length) {
        const unfinished = index < scenario.plannedCalls.length;
        const content = unfinished
          ? 'Stopped after the tool-call budget. Summarizing from the tool results already collected.'
          : answerFromToolText(scenario, toolText);
        return Promise.resolve({ content, toolCalls: [] });
      }
      const planned = scenario.plannedCalls[index];
      index += 1;
      if (!planned) return Promise.resolve({ content: '', toolCalls: [] });
      return Promise.resolve({
        content: '',
        toolCalls: [{ id: `call_${index}`, name: planned.name, arguments: planned.arguments }],
      });
    },
  };
}

function answerFromToolText(scenario: EvalScenario, toolText: string): string {
  if (scenario.id === 'create-issue-declined') {
    return toolText.includes('declined')
      ? 'The issue was not created because the write was declined.'
      : 'Unexpected tool result.';
  }
  if (scenario.id === 'create-issue-confirmed') {
    return toolText.includes('#101') || toolText.includes('/issues/101')
      ? 'Created issue #101.'
      : 'The tool result did not include the new issue number.';
  }
  const phrases = scenario.answerMustInclude.filter((phrase) => toolText.includes(phrase));
  if (phrases.length === 0) return 'Tool results did not include the expected facts.';
  return phrases.join('. ');
}

function sameCalls(
  actual: { name: string; arguments: Record<string, unknown> }[],
  expected: { name: string; arguments: Record<string, unknown> }[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
