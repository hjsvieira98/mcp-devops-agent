import { describe, expect, it } from 'vitest';

import { MemoryGitHub, type MemoryWorld } from '../src/github/memory.js';
import { createDevOpsServer } from '../src/server/create-server.js';
import { withClient } from './helpers.js';

const NOW = new Date('2026-04-02T15:00:00.000Z');

function world(): MemoryWorld {
  return {
    repositories: {
      'acme/web': {
        description: 'Storefront',
        commits: [
          {
            sha: 'aaa111aaa111',
            message: 'Add health check\n\nMore detail',
            author: 'ada',
            date: '2026-04-02T08:00:00.000Z',
            url: 'https://github.com/acme/web/commit/aaa111aaa111',
          },
          {
            sha: 'old000',
            message: 'Ancient migration',
            author: 'ada',
            date: '2026-01-01T00:00:00.000Z',
            url: 'https://github.com/acme/web/commit/old000',
          },
        ],
        issues: [
          {
            number: 3,
            title: 'Flaky login',
            url: 'https://github.com/acme/web/issues/3',
            state: 'open',
            author: 'ada',
            updatedAt: '2026-04-02T10:00:00.000Z',
            labels: ['bug'],
            body: 'Login test fails on retries.',
            isPullRequest: false,
          },
        ],
        pulls: [
          {
            number: 17,
            title: 'Reduce checkout latency',
            url: 'https://github.com/acme/web/pull/17',
            author: 'ada',
            draft: false,
            headRef: 'checkout-latency',
            headSha: 'abc123def456',
            baseRef: 'main',
            updatedAt: '2026-04-02T12:00:00.000Z',
            body: 'x'.repeat(2000),
            checkRunsForbidden: true,
            files: [
              {
                filename: 'src/checkout.ts',
                status: 'modified',
                additions: 3,
                deletions: 1,
                patch: 'y'.repeat(5000),
              },
            ],
            statuses: [
              {
                context: 'build',
                state: 'failure',
                targetUrl: 'https://github.com/acme/web/actions/runs/1',
                description: 'tests failed',
              },
            ],
          },
        ],
      },
    },
  };
}

function serverFor(github: MemoryGitHub) {
  return createDevOpsServer({
    github,
    repositories: [{ owner: 'acme', repo: 'web' }],
    version: '0.0.0-test',
    now: () => NOW,
  });
}

describe('MCP server', () => {
  it('lists tools, a watchlist resource, and both prompts', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'create_issue',
        'get_repo_activity',
        'list_issues',
        'list_open_pull_requests',
        'summarize_pull_request',
      ]);
      const create = tools.tools.find((tool) => tool.name === 'create_issue');
      expect(create?.annotations?.readOnlyHint).toBe(false);
      const read = tools.tools.find((tool) => tool.name === 'list_issues');
      expect(read?.annotations?.readOnlyHint).toBe(true);

      const watchlist = await client.readResource({ uri: 'devops://watchlist' });
      expect(watchlist.contents[0]).toMatchObject({
        text: JSON.stringify({ repositories: [{ owner: 'acme', repo: 'web' }] }),
      });

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
        'morning_standup',
        'pr_review_brief',
      ]);
      const standup = await client.getPrompt({
        name: 'morning_standup',
        arguments: { focus: 'checkout' },
      });
      const text = standup.messages[0]?.content;
      expect(text).toMatchObject({ type: 'text' });
      if (text && 'text' in text) expect(text.text).toContain('checkout');

      expect(client.getInstructions()).toContain('create_issue');
    });
  });

  it('rolls up CI from commit status when check runs are forbidden', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const result = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web' },
      });
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        pullRequests: { number: number; ci: { state: string } }[];
        warnings: string[];
      };
      expect(structured.pullRequests[0]?.ci.state).toBe('failure');
      expect(structured.warnings[0]).toMatch(/check-run/i);
      expect(github.calls.some((call) => call.method === 'listCheckRuns')).toBe(true);
    });
  });

  it('rejects invalid arguments before calling GitHub', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const result = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'not a name', repo: 'web', limit: 99 },
      });
      expect(result.isError).toBe(true);
      expect(github.calls).toEqual([]);
    });
  });

  it('truncates a pull request digest and keeps the filename', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const result = await client.callTool({
        name: 'summarize_pull_request',
        arguments: { owner: 'acme', repo: 'web', number: 17, maxPatchChars: 40 },
      });
      const structured = result.structuredContent as {
        files: { filename: string; patchTruncated: boolean }[];
        bodyTruncated: boolean;
      };
      expect(structured.files[0]?.filename).toBe('src/checkout.ts');
      expect(structured.files[0]?.patchTruncated).toBe(true);
      expect(structured.bodyTruncated).toBe(true);
      const text = result.content.find((block) => block.type === 'text');
      expect(text && 'text' in text ? text.text : '').toContain('src/checkout.ts');
    });
  });

  it('excludes pull requests from list_issues and old commits from activity', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const issues = await client.callTool({
        name: 'list_issues',
        arguments: { owner: 'acme', repo: 'web' },
      });
      const issueBody = issues.structuredContent as { issues: { number: number }[] };
      expect(issueBody.issues.map((issue) => issue.number)).toEqual([3]);

      const activity = await client.callTool({
        name: 'get_repo_activity',
        arguments: { owner: 'acme', repo: 'web' },
      });
      const activityBody = activity.structuredContent as {
        commits: { message: string }[];
        pullRequestsUpdated: { number: number }[];
        since: string;
      };
      expect(activityBody.commits.map((commit) => commit.message)).toEqual(['Add health check']);
      expect(activityBody.pullRequestsUpdated.map((pull) => pull.number)).toEqual([17]);
      expect(activityBody.since).toBe('2026-04-01T15:00:00.000Z');
    });
  });

  it('returns a missing-token error without throwing', async () => {
    const { createRuntimeServer } = await import('../src/runtime.js');
    const server = createRuntimeServer({ GITHUB_REPOS: 'acme/web' });
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'list_issues',
        arguments: { owner: 'acme', repo: 'web' },
      });
      expect(result.isError).toBe(true);
      const text = result.content.find((block) => block.type === 'text');
      const message = text && 'text' in text ? text.text : '';
      expect(message).toContain('GITHUB_TOKEN');
      expect(message).not.toContain('ghp_');
    });
  });

  it('reads a repository resource and reports an unknown repo as not found', async () => {
    const github = new MemoryGitHub(world());
    await withClient(serverFor(github), async (client) => {
      const found = await client.readResource({ uri: 'github://repo/acme/web' });
      const payload = JSON.parse(
        String(found.contents[0] && 'text' in found.contents[0] ? found.contents[0].text : '{}'),
      ) as {
        description: string;
        watched: boolean;
      };
      expect(payload.description).toBe('Storefront');
      expect(payload.watched).toBe(true);
      await expect(client.readResource({ uri: 'github://repo/acme/missing' })).rejects.toThrow(
        /acme\/missing|Not Found|could not find/i,
      );
    });
  });
});
