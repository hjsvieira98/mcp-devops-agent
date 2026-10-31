import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { WATCHLIST_URI } from '../constants.js';
import type { WatchedRepository } from '../config.js';
import { readVersion } from '../version.js';
import type { AgentTool, ToolCall } from './types.js';
import type { ToolExecution } from './loop.js';

const watchlistSchema = {
  parse(value: unknown): { repositories: WatchedRepository[] } {
    if (typeof value !== 'object' || value === null || !('repositories' in value)) {
      throw new Error('Watchlist resource was not an object.');
    }
    const repositories = value.repositories;
    if (!Array.isArray(repositories)) throw new Error('Watchlist repositories was not a list.');
    return {
      repositories: repositories.map((entry) => {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          typeof (entry as { owner?: unknown }).owner !== 'string' ||
          typeof (entry as { repo?: unknown }).repo !== 'string'
        ) {
          throw new Error('Watchlist entry was missing owner or repo.');
        }
        return {
          owner: (entry as { owner: string }).owner,
          repo: (entry as { repo: string }).repo,
        };
      }),
    };
  },
};

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
};

/**
 * A missing or non-true readOnlyHint is treated as a write.
 * The CLI then asks before calling it.
 */
export function toolFromMcp(tool: McpToolInfo): AgentTool {
  const schema = tool.inputSchema;
  const inputSchema =
    typeof schema === 'object' && schema !== null && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema,
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

export function readToolText(result: { content?: unknown; isError?: boolean }): ToolExecution {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text;
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  return { content: text, isError: result.isError === true };
}

export async function readWatchlist(client: Client): Promise<WatchedRepository[]> {
  const result = await client.readResource({ uri: WATCHLIST_URI });
  const text = result.contents
    .map((item) => ('text' in item && typeof item.text === 'string' ? item.text : ''))
    .join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('devops://watchlist did not contain JSON.');
  }
  return watchlistSchema.parse(parsed).repositories;
}

export function serverEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT']) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['GITHUB_TOKEN', 'GITHUB_REPOS', 'GITHUB_API_BASE_URL']) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function connectStdioServer(options: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'devops-agent', version: readVersion() });
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    env: options.env,
    stderr: 'inherit',
    cwd: process.cwd(),
  });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

export async function callMcpTool(client: Client, call: ToolCall): Promise<ToolExecution> {
  const result = await client.callTool({ name: call.name, arguments: call.arguments });
  return readToolText(result);
}
