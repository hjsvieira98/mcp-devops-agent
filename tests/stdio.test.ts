import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

describe('stdio server', () => {
  it('lists tools and the watchlist, and refuses GitHub calls without a token', async () => {
    const serverPath = path.resolve('src/index.ts');
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', serverPath],
      cwd: process.cwd(),
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_REPOS: 'acme/web',
      },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('summarize_pull_request');
      const watchlist = await client.readResource({ uri: 'devops://watchlist' });
      const text =
        watchlist.contents[0] && 'text' in watchlist.contents[0] ? watchlist.contents[0].text : '';
      expect(JSON.parse(text)).toEqual({ repositories: [{ owner: 'acme', repo: 'web' }] });

      const result = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
