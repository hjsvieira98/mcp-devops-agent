import { describe, expect, it } from 'vitest';

import { GitHubApiError, GitHubResponseError } from '../src/github/errors.js';
import { GitHubRestClient } from '../src/github/client.js';
import { jsonResponse } from './helpers.js';

const TOKEN = 'ghp_supersecret_token';

function client(fetchImpl: typeof fetch): GitHubRestClient {
  return new GitHubRestClient({
    token: TOKEN,
    baseUrl: 'https://api.github.test',
    fetch: fetchImpl,
    userAgent: 'devops-mcp-test',
  });
}

describe('GitHubRestClient', () => {
  it('lists pull requests and sends the token only as a bearer header', async () => {
    const seen: { authorization?: string; url?: string } = {};
    const github = client(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.url = url;
      seen.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return jsonResponse([
        {
          number: 7,
          title: 'Ship it',
          html_url: 'https://github.com/acme/web/pull/7',
          user: { login: 'ada' },
          updated_at: '2026-04-02T00:00:00Z',
          body: null,
          head: { ref: 'ship', sha: 'abc' },
          base: { ref: 'main' },
        },
      ]);
    });

    const pulls = await github.listOpenPullRequests('acme', 'web', 5);
    expect(pulls).toEqual([
      {
        number: 7,
        title: 'Ship it',
        url: 'https://github.com/acme/web/pull/7',
        author: 'ada',
        draft: false,
        headRef: 'ship',
        headSha: 'abc',
        baseRef: 'main',
        updatedAt: '2026-04-02T00:00:00Z',
        body: null,
      },
    ]);
    expect(seen.url).toContain('/repos/acme/web/pulls?');
    expect(seen.url).toContain('state=open');
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('omits the token from an error even when GitHub echoes it', async () => {
    const github = client(async () => jsonResponse({ message: `bad token ${TOKEN}` }, 401));
    await expect(github.getRepository('acme', 'web')).rejects.toThrow(GitHubApiError);
    try {
      await github.getRepository('acme', 'web');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const message =
        error instanceof Error
          ? `${error.message} ${(error as GitHubApiError).toUserMessage()}`
          : '';
      expect(message).not.toContain(TOKEN);
      expect(message).toContain('[redacted]');
      expect(message).toContain('401');
    }
  });

  it('describes a rate limit with the reset time', async () => {
    const github = client(async () =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
      }),
    );
    try {
      await github.getRepository('acme', 'web');
      expect.fail('expected a rate limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      if (error instanceof GitHubApiError) {
        expect(error.rateLimited).toBe(true);
        expect(error.toUserMessage()).toContain('rate limit');
        expect(error.toUserMessage()).toContain('2023-11-14');
      }
    }
  });

  it('rejects a payload that does not match the schema', async () => {
    const github = client(async () => jsonResponse([{ number: 1 }]));
    await expect(github.listOpenPullRequests('acme', 'web', 1)).rejects.toBeInstanceOf(
      GitHubResponseError,
    );
  });

  it('posts an issue body without sending the token in the JSON', async () => {
    let body = '';
    const github = client(async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({
        number: 4,
        title: 'Investigate',
        html_url: 'https://github.com/acme/web/issues/4',
        state: 'open',
        user: { login: 'ada' },
        updated_at: '2026-04-02T00:00:00Z',
        body: 'details',
        labels: [{ name: 'bug' }],
      });
    });
    const issue = await github.createIssue('acme', 'web', {
      title: 'Investigate',
      body: 'details',
      labels: ['bug'],
    });
    expect(JSON.parse(body)).toEqual({ title: 'Investigate', body: 'details', labels: ['bug'] });
    expect(body).not.toContain(TOKEN);
    expect(issue.number).toBe(4);
    expect(issue.isPullRequest).toBe(false);
    expect(issue.labels).toEqual(['bug']);
  });

  it('drops pull requests from the issues list', async () => {
    const github = client(async () =>
      jsonResponse([
        {
          number: 1,
          title: 'A pull',
          html_url: 'https://github.com/acme/web/pull/1',
          state: 'open',
          user: { login: 'ada' },
          updated_at: '2026-04-02T00:00:00Z',
          body: null,
          labels: [],
          pull_request: { url: 'https://api.github.com/repos/acme/web/pulls/1' },
        },
        {
          number: 2,
          title: 'A bug',
          html_url: 'https://github.com/acme/web/issues/2',
          state: 'open',
          user: null,
          updated_at: '2026-04-02T00:00:00Z',
          body: 'broken',
          labels: [],
        },
      ]),
    );
    const issues = await github.listIssues('acme', 'web', 'open', 10);
    expect(issues.map((issue) => issue.number)).toEqual([2]);
    expect(issues[0]?.author).toBe('ghost');
  });
});
