export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  updatedAt: string;
  body: string | null;
};

export type CommitStatus = {
  context: string;
  state: string;
  targetUrl: string | null;
  description: string | null;
};

export type CombinedCommitStatus = {
  statuses: CommitStatus[];
};

export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
};

export type PullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
};

export type IssueSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  updatedAt: string;
  labels: string[];
  body: string | null;
  isPullRequest: boolean;
};

export type CommitActivity = {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
};

export type RepositoryInfo = {
  owner: string;
  repo: string;
  description: string | null;
  defaultBranch: string;
  openIssues: number;
  url: string;
  private: boolean;
};

export type CreateIssueInput = {
  title: string;
  body?: string;
  labels?: string[];
};

export type IssueState = 'open' | 'closed' | 'all';

/** One page of a list. `hasMore` is true when another page exists after this one. */
export type ListPage<T> = {
  items: T[];
  hasMore: boolean;
};

/**
 * The only GitHub surface the MCP tools depend on.
 * Production code uses {@link GitHubRestClient}. Evals use an in-memory implementation.
 * `page` is 1-based. List methods never return more than the page-size cap.
 */
export interface GitHubClient {
  listOpenPullRequests(
    owner: string,
    repo: string,
    limit: number,
    page?: number,
  ): Promise<ListPage<PullRequestSummary>>;
  getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedCommitStatus>;
  listCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]>;
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestSummary>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    limit: number,
  ): Promise<PullRequestFile[]>;
  listIssues(
    owner: string,
    repo: string,
    state: IssueState,
    limit: number,
    page?: number,
  ): Promise<ListPage<IssueSummary>>;
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<IssueSummary>;
  listCommits(owner: string, repo: string, since: string, limit: number): Promise<CommitActivity[]>;
  listRecentIssues(
    owner: string,
    repo: string,
    since: string,
    limit: number,
  ): Promise<IssueSummary[]>;
  getRepository(owner: string, repo: string): Promise<RepositoryInfo>;
}
