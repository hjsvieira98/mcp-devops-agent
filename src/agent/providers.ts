import { z } from 'zod';

import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '../constants.js';
import { scrubSecret } from '../github/errors.js';
import type {
  AgentTool,
  ConversationMessage,
  LanguageModel,
  ModelCompletion,
  ToolCall,
} from './types.js';

export class ModelRequestError extends Error {
  override readonly name = 'ModelRequestError';
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export function createModelFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): LanguageModel {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = env.OPENAI_API_KEY?.trim() ?? '';
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  const provider = requested || (anthropicKey ? 'anthropic' : openaiKey ? 'openai' : '');

  if (provider === 'anthropic') {
    if (!anthropicKey) throw new ModelRequestError('ANTHROPIC_API_KEY is not set.');
    return createAnthropicModel({
      apiKey: anthropicKey,
      model: env.LLM_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
      fetch: fetchImpl,
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com',
    });
  }
  if (provider === 'openai') {
    if (!openaiKey) throw new ModelRequestError('OPENAI_API_KEY is not set.');
    return createOpenAiModel({
      apiKey: openaiKey,
      model: env.LLM_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
      fetch: fetchImpl,
      baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com',
    });
  }
  throw new ModelRequestError(
    'Set LLM_PROVIDER to "anthropic" or "openai", and set the matching API key. LLM_MODEL overrides the default model.',
  );
}

export function createAnthropicModel(options: {
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  baseUrl: string;
}): LanguageModel {
  return {
    provider: 'anthropic',
    model: options.model,
    async complete({ messages, tools }) {
      const body = anthropicRequest(messages, tools, options.model);
      const response = await options.fetch(`${options.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2026-10-21',
        },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ModelRequestError(
          `Anthropic request failed (HTTP ${response.status}): ${scrubSecret(extractError(raw), options.apiKey)}`,
        );
      }
      return parseAnthropicCompletion(raw);
    },
  };
}

export function createOpenAiModel(options: {
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  baseUrl: string;
}): LanguageModel {
  return {
    provider: 'openai',
    model: options.model,
    async complete({ messages, tools }) {
      const body = openAiRequest(messages, tools, options.model);
      const response = await options.fetch(
        `${options.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
        },
      );
      const raw = await response.text();
      if (!response.ok) {
        throw new ModelRequestError(
          `OpenAI request failed (HTTP ${response.status}): ${scrubSecret(extractError(raw), options.apiKey)}`,
        );
      }
      return parseOpenAiCompletion(raw);
    },
  };
}

export function anthropicRequest(
  messages: readonly ConversationMessage[],
  tools: readonly AgentTool[],
  model: string,
): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: toAnthropicMessages(messages),
  };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  return body;
}

export function openAiRequest(
  messages: readonly ConversationMessage[],
  tools: readonly AgentTool[],
  model: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_completion_tokens: 4096,
    messages: toOpenAiMessages(messages),
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return body;
}

export function parseAnthropicCompletion(raw: string): ModelCompletion {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new ModelRequestError('Anthropic returned a response that was not JSON.');
  }
  const parsed = z
    .object({
      content: z.array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
          id: z.string().optional(),
          name: z.string().optional(),
          input: z.unknown().optional(),
        }),
      ),
    })
    .safeParse(json);
  if (!parsed.success) {
    throw new ModelRequestError('Anthropic returned a response this agent could not parse.');
  }
  const text = parsed.data.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text ?? '')
    .join('');
  const toolCalls: ToolCall[] = [];
  for (const block of parsed.data.content) {
    if (block.type !== 'tool_use') continue;
    const call = toolCallSchema.safeParse({
      id: block.id,
      name: block.name,
      arguments: block.input,
    });
    if (!call.success) {
      throw new ModelRequestError('Anthropic returned a tool call this agent could not parse.');
    }
    toolCalls.push(call.data);
  }
  return { content: text, toolCalls };
}

export function parseOpenAiCompletion(raw: string): ModelCompletion {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new ModelRequestError('OpenAI returned a response that was not JSON.');
  }
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z.string().nullable().optional(),
              tool_calls: z
                .array(
                  z.object({
                    id: z.string(),
                    function: z.object({
                      name: z.string(),
                      arguments: z.string(),
                    }),
                  }),
                )
                .nullable()
                .optional(),
            }),
          }),
        )
        .min(1),
    })
    .safeParse(json);
  if (!parsed.success) {
    throw new ModelRequestError('OpenAI returned a response this agent could not parse.');
  }
  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ModelRequestError('OpenAI returned no choices.');
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments) as unknown;
    } catch {
      throw new ModelRequestError(
        `OpenAI returned tool arguments for ${call.function.name} that were not JSON.`,
      );
    }
    const parsedCall = toolCallSchema.safeParse({
      id: call.id,
      name: call.function.name,
      arguments: args,
    });
    if (!parsedCall.success) {
      throw new ModelRequestError(
        `OpenAI returned a tool call for ${call.function.name} that was not an object.`,
      );
    }
    toolCalls.push(parsedCall.data);
  }
  return { content: message.content ?? '', toolCalls };
}

function toAnthropicMessages(messages: readonly ConversationMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    const block = {
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: message.isError,
    };
    const last = out.at(-1) as { role?: string; content?: unknown } | undefined;
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

function toOpenAiMessages(messages: readonly ConversationMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      });
    } else {
      const content = message.isError ? `Error: ${message.content}` : message.content;
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content });
    }
  }
  return out;
}

function extractError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message || parsed.message || raw.slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}
