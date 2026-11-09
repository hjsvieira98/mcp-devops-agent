import { describe, expect, it } from 'vitest';

import { MemoryGitHub, type MemoryPull, type MemoryWorld } from '../src/github/memory.js';
import type { IssueSummary } from '../src/github/types.js';
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
      const pullsTool = tools.tools.find((tool) => tool.name === 'list_open_pull_requests');
      expect(schemaProperties(pullsTool?.inputSchema).cursor).toMatchObject({ type: 'string' });
      expect(schemaProperties(read?.inputSchema).cursor).toMatchObject({ type: 'string' });
      const activity = tools.tools.find((tool) => tool.name === 'get_repo_activity');
      expect(schemaProperties(activity?.inputSchema).cursor).toBeUndefined();

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
      expect(client.getInstructions()).toContain('private key');
      const listed = JSON.stringify(tools.tools).toLowerCase();
      for (const secretField of ['github_token', 'private_key', 'private key', 'installation_id']) {
        expect(listed).not.toContain(secretField);
      }
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
      expect(structured).toMatchObject({ nextCursor: null });
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
      const issueBody = issues.structuredContent as {
        issues: { number: number }[];
        nextCursor: string | null;
      };
      expect(issueBody.issues.map((issue) => issue.number)).toEqual([3]);
      expect(issueBody.nextCursor).toBeNull();

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
      expect(message).toContain('private key');
      expect(message).toContain('Do not paste');
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

  it('pages pull requests and rejects a malformed, tampered, or mismatched cursor', async () => {
    const pulls = Array.from({ length: 25 }, (_, index) => {
      const number = index + 1;
      const pull = pullFixture(number);
      if (number === 11) {
        pull.statuses = [
          {
            context: 'build',
            state: 'failure',
            targetUrl: null,
            description: 'tests failed',
          },
        ];
      }
      return pull;
    });
    const github = new MemoryGitHub({ repositories: { 'acme/web': { pulls } } });
    await withClient(serverFor(github), async (client) => {
      const first = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', limit: 10 },
      });
      const page1 = first.structuredContent as PullPage;
      expect(first.isError).toBeUndefined();
      expect(page1.pullRequests.map((pull) => pull.number)).toEqual(range(1, 10));
      expect(page1.nextCursor).toEqual(expect.any(String));
      expect(toolText(first)).toContain(`nextCursor: ${page1.nextCursor}`);

      const second = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', limit: 10, cursor: page1.nextCursor },
      });
      const page2 = second.structuredContent as PullPage;
      expect(page2.pullRequests.map((pull) => pull.number)).toEqual(range(11, 20));
      expect(page2.pullRequests.find((pull) => pull.number === 11)?.ci.state).toBe('failure');
      expect(page2.nextCursor).toEqual(expect.any(String));

      const third = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', limit: 10, cursor: page2.nextCursor },
      });
      const page3 = third.structuredContent as PullPage;
      expect(page3.pullRequests.map((pull) => pull.number)).toEqual(range(21, 25));
      expect(page3.nextCursor).toBeNull();
      expect(page3.warnings).toEqual([]);

      const callsAfterPages = github.calls.length;
      const malformed = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', cursor: 'not-a-cursor' },
      });
      expect(malformed.isError).toBe(true);
      expect(toolText(malformed)).toMatch(/malformed/i);
      expect(github.calls).toHaveLength(callsAfterPages);

      const tampered = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: {
          owner: 'acme',
          repo: 'web',
          limit: 10,
          cursor: rewriteCursorPage(page1.nextCursor ?? '', 9),
        },
      });
      expect(tampered.isError).toBe(true);
      expect(toolText(tampered)).toMatch(/tampered/i);
      expect(github.calls).toHaveLength(callsAfterPages);

      const mismatched = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', limit: 5, cursor: page1.nextCursor },
      });
      expect(mismatched.isError).toBe(true);
      expect(toolText(mismatched)).toMatch(/does not match/i);
      expect(github.calls).toHaveLength(callsAfterPages);
    });
  });

  it('skips pull requests inside an issues page and still returns a cursor', async () => {
    const github = new MemoryGitHub({
      repositories: {
        'acme/web': {
          issues: [
            issueFixture(1, { isPullRequest: true, title: 'Hidden pull' }),
            issueFixture(2, { title: 'Real two' }),
            issueFixture(3, { title: 'Real three' }),
          ],
        },
      },
    });
    await withClient(serverFor(github), async (client) => {
      const first = await client.callTool({
        name: 'list_issues',
        arguments: { owner: 'acme', repo: 'web', limit: 2 },
      });
      const page1 = first.structuredContent as IssuePage;
      expect(page1.issues.map((issue) => issue.number)).toEqual([2]);
      expect(page1.nextCursor).toEqual(expect.any(String));

      const second = await client.callTool({
        name: 'list_issues',
        arguments: { owner: 'acme', repo: 'web', limit: 2, cursor: page1.nextCursor },
      });
      const page2 = second.structuredContent as IssuePage;
      expect(page2.issues.map((issue) => issue.title)).toEqual(['Real three']);
      expect(page2.nextCursor).toBeNull();

      const wrongTool = await client.callTool({
        name: 'list_open_pull_requests',
        arguments: { owner: 'acme', repo: 'web', limit: 2, cursor: page1.nextCursor },
      });
      expect(wrongTool.isError).toBe(true);
      expect(toolText(wrongTool)).toMatch(/does not match/i);
      expect(github.calls.filter((call) => call.method === 'listOpenPullRequests')).toEqual([]);
    });
  });

  it('stops following issue cursors at the result cap', async () => {
    const github = new MemoryGitHub({
      repositories: {
        'acme/web': {
          issues: Array.from({ length: 100 }, (_, index) => issueFixture(index + 1)),
        },
      },
    });
    await withClient(serverFor(github), async (client) => {
      let cursor: string | null = null;
      const seen: number[] = [];
      for (let step = 0; step < 4; step += 1) {
        const result = await client.callTool({
          name: 'list_issues',
          arguments: {
            owner: 'acme',
            repo: 'web',
            limit: 30,
            ...(cursor ? { cursor } : {}),
          },
        });
        expect(result.isError).toBeUndefined();
        const body = result.structuredContent as IssuePage;
        seen.push(...body.issues.map((issue) => issue.number));
        if (step < 2) {
          expect(body.nextCursor).toEqual(expect.any(String));
          expect(body.warnings).toEqual([]);
          cursor = body.nextCursor;
        } else {
          expect(body.nextCursor).toBeNull();
          expect(body.warnings.join('\n')).toMatch(/cap of 100/);
          expect(toolText(result)).toMatch(/cap of 100/);
          expect(body.issues).toHaveLength(30);
          break;
        }
      }
      expect(seen).toEqual(range(1, 90));
    });
  });
});

type PullPage = {
  pullRequests: { number: number; ci: { state: string } }[];
  nextCursor: string | null;
  warnings: string[];
};

type IssuePage = {
  issues: { number: number; title: string }[];
  nextCursor: string | null;
  warnings: string[];
};

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || !('properties' in schema)) return {};
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return {};
  return properties as Record<string, unknown>;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function toolText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function rewriteCursorPage(token: string, page: number): string {
  const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { page: number };
  json.page = page;
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
}

function pullFixture(number: number): MemoryPull {
  return {
    number,
    title: `Pull ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    author: 'ada',
    draft: false,
    headRef: `branch-${number}`,
    headSha: `sha-${number}`,
    baseRef: 'main',
    updatedAt: '2026-04-02T12:00:00.000Z',
    body: null,
  };
}

function issueFixture(
  number: number,
  extra: Partial<Pick<IssueSummary, 'title' | 'isPullRequest'>> = {},
): IssueSummary {
  return {
    number,
    title: extra.title ?? `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    state: 'open',
    author: 'ada',
    updatedAt: '2026-04-02T10:00:00.000Z',
    labels: [],
    body: null,
    isPullRequest: extra.isPullRequest ?? false,
  };
}
