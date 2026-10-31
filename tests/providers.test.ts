import { describe, expect, it } from 'vitest';

import type { ConversationMessage } from '../src/agent/types.js';
import {
  anthropicRequest,
  createAnthropicModel,
  createModelFromEnv,
  createOpenAiModel,
  ModelRequestError,
  openAiRequest,
  parseAnthropicCompletion,
  parseOpenAiCompletion,
} from '../src/agent/providers.js';

const messages: ConversationMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'What is open?' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'list_issues', content: 'none', isError: false },
];

const tools = [
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
    readOnly: true,
  },
];

describe('provider request mapping', () => {
  it('maps a conversation onto the Anthropic messages API', () => {
    const body = anthropicRequest(messages, tools, 'claude-sonnet-5-5');
    expect(body.system).toBe('Be brief.');
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('temperature');
    const wire = body.messages as { role: string; content: unknown }[];
    expect(wire[1]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'list_issues',
          input: { owner: 'acme', repo: 'web' },
        },
      ],
    });
    expect(wire[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'none', is_error: false }],
    });
  });

  it('maps a conversation onto OpenAI chat completions', () => {
    const body = openAiRequest(messages, tools, 'gpt-5.4');
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty('temperature');
    const wire = body.messages as {
      role: string;
      tool_calls?: { function: { arguments: string } }[];
    }[];
    expect(wire[0]).toMatchObject({ role: 'system', content: 'Be brief.' });
    expect(JSON.parse(wire[2]?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      owner: 'acme',
      repo: 'web',
    });
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'none' });
  });

  it('parses tool calls from both providers', () => {
    expect(
      parseAnthropicCompletion(
        JSON.stringify({
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'list_issues', input: { owner: 'acme' } },
          ],
        }),
      ),
    ).toEqual({
      content: 'Looking.',
      toolCalls: [{ id: 'toolu_1', name: 'list_issues', arguments: { owner: 'acme' } }],
    });

    expect(
      parseOpenAiCompletion(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_9',
                    function: { name: 'list_issues', arguments: '{"owner":"acme"}' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toEqual({
      content: '',
      toolCalls: [{ id: 'call_9', name: 'list_issues', arguments: { owner: 'acme' } }],
    });
  });
});

describe('provider HTTP adapters', () => {
  it('selects Anthropic when that key is the only one set', () => {
    const model = createModelFromEnv({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(model.provider).toBe('anthropic');
    expect(model.model).toBe('claude-sonnet-5-5');
  });

  it('redacts the API key from a failed Anthropic response', async () => {
    const secret = 'sk-ant-secret-value';
    const model = createAnthropicModel({
      apiKey: secret,
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://api.anthropic.test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: `invalid ${secret}` } }), { status: 401 }),
    });
    await expect(model.complete({ messages, tools })).rejects.toThrow(ModelRequestError);
    try {
      await model.complete({ messages, tools });
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
      expect(error instanceof Error ? error.message : '').toContain('[redacted]');
    }
  });

  it('redacts the API key from a failed OpenAI response', async () => {
    const secret = 'sk-openai-secret-value';
    const model = createOpenAiModel({
      apiKey: secret,
      model: 'gpt-5.4',
      baseUrl: 'https://api.openai.test',
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
        return new Response(JSON.stringify({ error: { message: secret } }), { status: 401 });
      },
    });
    await expect(model.complete({ messages, tools: [] })).rejects.toThrow(/\[redacted\]/);
  });
});
