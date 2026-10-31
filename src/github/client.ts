import { z } from 'zod';

import { GitHubApiError, GitHubResponseError, scrubSecret } from './errors.js';
import type {
  CheckRun,
  CombinedCommitStatus,
  CommitActivity,
  CreateIssueInput,
  GitHubClient,
  IssueState,
  IssueSummary,
  PullRequestFile,
  PullRequestSummary,
  RepositoryInfo,
} from './types.js';

const userSchema = z.object({ login: z.string() }).nullable();

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional().default(false),
  user: userSchema,
  updated_at: z.string(),
  body: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const statusSchema = z.object({
  state: z.string(),
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
});

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().nullable(),
    }),
  ),
});

const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});

const labelSchema = z.object({ name: z.string() });

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  user: userSchema,
  updated_at: z.string(),
  body: z.string().nullable(),
  labels: z
    .array(z.union([labelSchema, z.string()]))
    .optional()
    .default([]),
  pull_request: z.unknown().optional(),
});

const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({
        name: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  author: userSchema,
});

const repoSchema = z.object({
  description: z.string().nullable(),
  default_branch: z.string(),
  open_issues_count: z.number(),
  html_url: z.string(),
  private: z.boolean(),
});

export type GitHubRestClientOptions = {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
};

export class GitHubRestClient implements GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubRestClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? 'devops-mcp';
  }

  listOpenPullRequests(owner: string, repo: string, limit: number): Promise<PullRequestSummary[]> {
    return this.getList(
      `/repos/${segment(owner)}/${segment(repo)}/pulls`,
      { state: 'open', per_page: limit, page: 1 },
      z.array(pullSchema),
      (pulls) => pulls.map(toPull),
    );
  }

  async getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedCommitStatus> {
    const body = await this.get(
      `/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/status`,
      statusSchema,
    );
    return {
      statuses: body.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        targetUrl: status.target_url,
        description: status.description,
      })),
    };
  }

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const body = await this.get(
      `/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/check-runs`,
      checkRunsSchema,
      { per_page: 100 },
    );
    return body.check_runs.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.html_url,
    }));
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestSummary> {
    const pull = await this.get(
      `/repos/${segment(owner)}/${segment(repo)}/pulls/${number}`,
      pullSchema,
    );
    return toPull(pull);
  }

  listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    limit: number,
  ): Promise<PullRequestFile[]> {
    return this.getList(
      `/repos/${segment(owner)}/${segment(repo)}/pulls/${number}/files`,
      { per_page: limit, page: 1 },
      z.array(fileSchema),
      (files) =>
        files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
    );
  }

  async listIssues(
    owner: string,
    repo: string,
    state: IssueState,
    limit: number,
  ): Promise<IssueSummary[]> {
    const issues = await this.fetchIssues(owner, repo, { state, per_page: limit, page: 1 });
    return issues.filter((issue) => !issue.isPullRequest).slice(0, limit);
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<IssueSummary> {
    const issue = await this.send(
      `/repos/${segment(owner)}/${segment(repo)}/issues`,
      { method: 'POST', body: input },
      issueSchema,
    );
    return toIssue(issue);
  }

  listCommits(
    owner: string,
    repo: string,
    since: string,
    limit: number,
  ): Promise<CommitActivity[]> {
    return this.getList(
      `/repos/${segment(owner)}/${segment(repo)}/commits`,
      { since, per_page: limit, page: 1 },
      z.array(commitSchema),
      (commits) =>
        commits.map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message,
          author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
          date: commit.commit.author?.date ?? '',
          url: commit.html_url,
        })),
    );
  }

  listRecentIssues(
    owner: string,
    repo: string,
    since: string,
    limit: number,
  ): Promise<IssueSummary[]> {
    return this.fetchIssues(owner, repo, { state: 'all', since, per_page: limit, page: 1 });
  }

  async getRepository(owner: string, repo: string): Promise<RepositoryInfo> {
    const body = await this.get(`/repos/${segment(owner)}/${segment(repo)}`, repoSchema);
    return {
      owner,
      repo,
      description: body.description,
      defaultBranch: body.default_branch,
      openIssues: body.open_issues_count,
      url: body.html_url,
      private: body.private,
    };
  }

  private fetchIssues(
    owner: string,
    repo: string,
    query: Record<string, string | number | undefined>,
  ): Promise<IssueSummary[]> {
    return this.getList(
      `/repos/${segment(owner)}/${segment(repo)}/issues`,
      query,
      z.array(issueSchema),
      (issues) => issues.map(toIssue),
    );
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.send(path, { query }, schema);
  }

  private async getList<T, R>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: z.ZodType<T>,
    map: (value: T) => R,
  ): Promise<R> {
    const value = await this.get(path, schema, query);
    return map(value);
  }

  private async send<T>(
    path: string,
    init: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': this.userAgent,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network request failed';
      throw new GitHubApiError(0, path, scrubSecret(message, this.token), null, false);
    }

    const raw = await response.text();
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const rateLimitReset = resetHeader ? isoFromUnixSeconds(resetHeader) : null;
    const remaining = response.headers.get('x-ratelimit-remaining');
    let payload: unknown = null;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new GitHubApiError(
          response.status,
          path,
          'Response was not valid JSON.',
          rateLimitReset,
          false,
        );
      }
    }

    if (!response.ok) {
      const message = scrubSecret(truncate(githubMessage(payload), 400), this.token);
      const rateLimited = response.status === 429 || (response.status === 403 && remaining === '0');
      throw new GitHubApiError(response.status, path, message, rateLimitReset, rateLimited);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .slice(0, 5)
        .join('; ');
      throw new GitHubResponseError(path, detail);
    }
    return parsed.data;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function toPull(pull: z.infer<typeof pullSchema>): PullRequestSummary {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? 'ghost',
    draft: pull.draft,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    updatedAt: pull.updated_at,
    body: pull.body,
  };
}

function toIssue(issue: z.infer<typeof issueSchema>): IssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    author: issue.user?.login ?? 'ghost',
    updatedAt: issue.updated_at,
    labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
    body: issue.body,
    isPullRequest: issue.pull_request !== undefined,
  };
}

function githubMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload && 'message' in payload) {
    const message = payload.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'GitHub returned an error without a message.';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function isoFromUnixSeconds(value: string): string | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}
