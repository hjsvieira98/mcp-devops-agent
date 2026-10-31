import { GitHubApiError } from './errors.js';
import type {
  CheckRun,
  CombinedCommitStatus,
  CommitActivity,
  CommitStatus,
  CreateIssueInput,
  GitHubClient,
  IssueState,
  IssueSummary,
  PullRequestFile,
  PullRequestSummary,
  RepositoryInfo,
} from './types.js';

export type MemoryCall = {
  method: keyof GitHubClient;
  args: unknown[];
};

export type MemoryPull = PullRequestSummary & {
  files?: PullRequestFile[];
  statuses?: CommitStatus[];
  checkRuns?: CheckRun[];
  /** When set, listCheckRuns throws 403 so tools can fall back to commit statuses. */
  checkRunsForbidden?: boolean;
};

export type MemoryRepository = {
  description?: string | null;
  defaultBranch?: string;
  private?: boolean;
  url?: string;
  commits?: CommitActivity[];
  issues?: IssueSummary[];
  pulls?: MemoryPull[];
};

export type MemoryWorld = {
  repositories: Record<string, MemoryRepository | undefined>;
  nextIssueNumber?: number;
};

/**
 * In-memory GitHub used by unit tests and evals. It records calls and never touches the network.
 */
export class MemoryGitHub implements GitHubClient {
  readonly calls: MemoryCall[] = [];
  private nextIssueNumber: number;

  constructor(private readonly world: MemoryWorld) {
    this.nextIssueNumber = world.nextIssueNumber ?? 101;
  }

  listOpenPullRequests(owner: string, repo: string, limit: number): Promise<PullRequestSummary[]> {
    const record = this.requireRepo('listOpenPullRequests', owner, repo, [owner, repo, limit]);
    const pulls = (record.pulls ?? []).slice(0, limit).map(stripPull);
    return Promise.resolve(pulls);
  }

  getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedCommitStatus> {
    const record = this.requireRepo('getCombinedStatus', owner, repo, [owner, repo, ref]);
    const pull = (record.pulls ?? []).find((item) => item.headSha === ref);
    return Promise.resolve({ statuses: pull?.statuses ?? [] });
  }

  listCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const record = this.requireRepo('listCheckRuns', owner, repo, [owner, repo, ref]);
    const pull = (record.pulls ?? []).find((item) => item.headSha === ref);
    if (pull?.checkRunsForbidden) {
      return Promise.reject(
        new GitHubApiError(
          403,
          `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
          'Resource not accessible by integration',
          null,
          false,
        ),
      );
    }
    return Promise.resolve(pull?.checkRuns ?? []);
  }

  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestSummary> {
    const record = this.requireRepo('getPullRequest', owner, repo, [owner, repo, number]);
    const pull = (record.pulls ?? []).find((item) => item.number === number);
    if (!pull) {
      return Promise.reject(
        new GitHubApiError(
          404,
          `/repos/${owner}/${repo}/pulls/${number}`,
          'Not Found',
          null,
          false,
        ),
      );
    }
    return Promise.resolve(stripPull(pull));
  }

  listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    limit: number,
  ): Promise<PullRequestFile[]> {
    const record = this.requireRepo('listPullRequestFiles', owner, repo, [
      owner,
      repo,
      number,
      limit,
    ]);
    const pull = (record.pulls ?? []).find((item) => item.number === number);
    if (!pull) {
      return Promise.reject(
        new GitHubApiError(
          404,
          `/repos/${owner}/${repo}/pulls/${number}/files`,
          'Not Found',
          null,
          false,
        ),
      );
    }
    return Promise.resolve((pull.files ?? []).slice(0, limit));
  }

  listIssues(
    owner: string,
    repo: string,
    state: IssueState,
    limit: number,
  ): Promise<IssueSummary[]> {
    const record = this.requireRepo('listIssues', owner, repo, [owner, repo, state, limit]);
    return Promise.resolve(
      (record.issues ?? [])
        .filter((issue) => !issue.isPullRequest && (state === 'all' || issue.state === state))
        .slice(0, limit),
    );
  }

  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<IssueSummary> {
    const record = this.requireRepo('createIssue', owner, repo, [owner, repo, input]);
    const issue: IssueSummary = {
      number: this.nextIssueNumber,
      title: input.title,
      url: `https://github.com/${owner}/${repo}/issues/${this.nextIssueNumber}`,
      state: 'open',
      author: 'octocat',
      updatedAt: new Date(0).toISOString(),
      labels: input.labels ?? [],
      body: input.body ?? null,
      isPullRequest: false,
    };
    this.nextIssueNumber += 1;
    record.issues = [...(record.issues ?? []), issue];
    return Promise.resolve(issue);
  }

  listCommits(
    owner: string,
    repo: string,
    since: string,
    limit: number,
  ): Promise<CommitActivity[]> {
    const record = this.requireRepo('listCommits', owner, repo, [owner, repo, since, limit]);
    const sinceTime = Date.parse(since);
    return Promise.resolve(
      (record.commits ?? [])
        .filter((commit) => Date.parse(commit.date) >= sinceTime)
        .slice(0, limit),
    );
  }

  listRecentIssues(
    owner: string,
    repo: string,
    since: string,
    limit: number,
  ): Promise<IssueSummary[]> {
    const record = this.requireRepo('listRecentIssues', owner, repo, [owner, repo, since, limit]);
    const sinceTime = Date.parse(since);
    const pullsAsIssues: IssueSummary[] = (record.pulls ?? []).map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: 'open',
      author: pull.author,
      updatedAt: pull.updatedAt,
      labels: [],
      body: pull.body,
      isPullRequest: true,
    }));
    return Promise.resolve(
      [...(record.issues ?? []), ...pullsAsIssues]
        .filter((issue) => Date.parse(issue.updatedAt) >= sinceTime)
        .slice(0, limit),
    );
  }

  getRepository(owner: string, repo: string): Promise<RepositoryInfo> {
    const record = this.requireRepo('getRepository', owner, repo, [owner, repo]);
    const openIssues = (record.issues ?? []).filter(
      (issue) => issue.state === 'open' && !issue.isPullRequest,
    ).length;
    return Promise.resolve({
      owner,
      repo,
      description: record.description ?? null,
      defaultBranch: record.defaultBranch ?? 'main',
      openIssues,
      url: record.url ?? `https://github.com/${owner}/${repo}`,
      private: record.private ?? false,
    });
  }

  private requireRepo(
    method: keyof GitHubClient,
    owner: string,
    repo: string,
    args: unknown[],
  ): MemoryRepository {
    this.calls.push({ method, args });
    const record = this.world.repositories[`${owner}/${repo}`];
    if (!record) {
      throw new GitHubApiError(404, `/repos/${owner}/${repo}`, 'Not Found', null, false);
    }
    return record;
  }
}

function stripPull(pull: MemoryPull): PullRequestSummary {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    author: pull.author,
    draft: pull.draft,
    headRef: pull.headRef,
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    updatedAt: pull.updatedAt,
    body: pull.body,
  };
}
