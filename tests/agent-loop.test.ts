import { describe, expect, it } from 'vitest';

import { runAgent } from '../src/agent/loop.js';
import { serverEnvironment, toolFromMcp } from '../src/agent/mcp.js';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import type { AgentTool, LanguageModel, ToolCall } from '../src/agent/types.js';

const readTool: AgentTool = {
  name: 'list_issues',
  description: 'List issues',
  inputSchema: { type: 'object' },
  readOnly: true,
};

const writeTool: AgentTool = {
  name: 'create_issue',
  description: 'Create an issue',
  inputSchema: { type: 'object' },
  readOnly: false,
};

function scripted(calls: ToolCall[], finalText = 'done'): LanguageModel {
  let index = 0;
  return {
    provider: 'script',
    model: 'script',
    complete({ tools }) {
      if (tools.length === 0 || index >= calls.length) {
        return Promise.resolve({ content: finalText, toolCalls: [] });
      }
      const call = calls[index];
      index += 1;
      if (!call) return Promise.resolve({ content: finalText, toolCalls: [] });
      return Promise.resolve({ content: '', toolCalls: [call] });
    },
  };
}

describe('runAgent', () => {
  it('executes a read tool without asking for confirmation', async () => {
    const executed: string[] = [];
    let confirmations = 0;
    const result = await runAgent({
      model: scripted([{ id: '1', name: 'list_issues', arguments: { owner: 'acme' } }]),
      tools: [readTool, writeTool],
      system: 'system',
      task: 'list issues',
      maxSteps: 4,
      confirmWrite: async () => {
        confirmations += 1;
        return false;
      },
      execute: async (call) => {
        executed.push(call.name);
        return { content: 'issues: none', isError: false };
      },
    });
    expect(executed).toEqual(['list_issues']);
    expect(confirmations).toBe(0);
    expect(result.stoppedReason).toBe('completed');
    expect(result.text).toBe('done');
  });

  it('does not execute a write tool when confirmation is denied', async () => {
    const executed: string[] = [];
    const result = await runAgent({
      model: scripted(
        [{ id: '1', name: 'create_issue', arguments: { title: 'Bug' } }],
        'not created',
      ),
      tools: [writeTool],
      system: 'system',
      task: 'create an issue',
      maxSteps: 4,
      confirmWrite: async () => false,
      execute: async (call) => {
        executed.push(call.name);
        return { content: 'created', isError: false };
      },
    });
    expect(executed).toEqual([]);
    expect(result.toolCalls[0]?.executed).toBe(false);
    expect(result.toolCalls[0]?.content).toContain('declined');
    expect(result.text).toBe('not created');
  });

  it('executes a write tool after confirmation', async () => {
    const executed: string[] = [];
    await runAgent({
      model: scripted([{ id: '1', name: 'create_issue', arguments: { title: 'Bug' } }]),
      tools: [writeTool],
      system: 'system',
      task: 'create an issue',
      maxSteps: 4,
      confirmWrite: async () => true,
      execute: async (call) => {
        executed.push(call.name);
        return { content: 'created #4', isError: false };
      },
    });
    expect(executed).toEqual(['create_issue']);
  });

  it('stops at the tool-call budget and still returns the final turn', async () => {
    const calls: ToolCall[] = [
      { id: '1', name: 'list_issues', arguments: {} },
      { id: '2', name: 'list_issues', arguments: {} },
      { id: '3', name: 'list_issues', arguments: {} },
    ];
    let executions = 0;
    const result = await runAgent({
      model: scripted(calls, 'budget answer'),
      tools: [readTool],
      system: 'system',
      task: 'keep listing',
      maxSteps: 2,
      confirmWrite: async () => false,
      execute: async () => {
        executions += 1;
        return { content: 'ok', isError: false };
      },
    });
    expect(executions).toBe(2);
    expect(result.stoppedReason).toBe('max_steps');
    expect(result.text).toBe('budget answer');
  });

  it('treats a tool without readOnlyHint as a write', () => {
    expect(toolFromMcp({ name: 'create_issue' }).readOnly).toBe(false);
    expect(toolFromMcp({ name: 'list_issues', annotations: { readOnlyHint: true } }).readOnly).toBe(
      true,
    );
  });
});

describe('serverEnvironment', () => {
  it('forwards GitHub settings and drops model credentials', () => {
    const env = serverEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPOS: 'acme/web',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      LLM_MODEL: 'claude-sonnet-5-5',
    });
    expect(env.GITHUB_TOKEN).toBe('ghp_test');
    expect(env.GITHUB_REPOS).toBe('acme/web');
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('LLM_MODEL');
  });
});

describe('buildSystemPrompt', () => {
  it('names the watched repositories', () => {
    const prompt = buildSystemPrompt([{ owner: 'acme', repo: 'web' }]);
    expect(prompt).toContain('acme/web');
    expect(prompt).toContain('create_issue');
  });
});
