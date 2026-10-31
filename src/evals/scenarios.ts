import type { WatchedRepository } from '../config.js';
import type { MemoryWorld } from '../github/memory.js';

export type PlannedCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type EvalScenario = {
  id: string;
  title: string;
  task: string;
  repositories: WatchedRepository[];
  world: MemoryWorld;
  now: string;
  plannedCalls: PlannedCall[];
  expectedExecuted: PlannedCall[];
  forbiddenExecuted: string[];
  confirmWrites: boolean;
  maxSteps: number;
  stoppedReason: 'completed' | 'max_steps';
  answerMustInclude: string[];
  /** When true, MemoryGitHub.createIssue must not have been called. */
  forbidGitHubCreate: boolean;
};

const NOW = '2026-04-02T15:00:00.000Z';

const webPull = {
  number: 17,
  title: 'Reduce checkout latency',
  url: 'https://github.com/acme/web/pull/17',
  author: 'ada',
  draft: false,
  headRef: 'checkout-latency',
  headSha: 'abc123def456',
  baseRef: 'main',
  updatedAt: '2026-04-02T12:00:00.000Z',
  body: 'Cache the shipping quote.',
  files: [
    {
      filename: 'src/checkout.ts',
      status: 'modified',
      additions: 20,
      deletions: 4,
      patch: '@@ -1,3 +1,5 @@\n+const cache = new Map();\n',
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
  checkRuns: [
    {
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/acme/web/actions/runs/1',
    },
  ],
};

const apiPull = {
  number: 8,
  title: 'Document auth',
  url: 'https://github.com/acme/api/pull/8',
  author: 'grace',
  draft: false,
  headRef: 'docs-auth',
  headSha: 'fff999eee888',
  baseRef: 'main',
  updatedAt: '2026-04-02T09:00:00.000Z',
  body: 'Describe the bearer token.',
  files: [],
  statuses: [{ context: 'build', state: 'success', targetUrl: null, description: null }],
  checkRuns: [],
};

function world(): MemoryWorld {
  return {
    repositories: {
      'acme/web': {
        description: 'Storefront',
        commits: [
          {
            sha: 'aaa111',
            message: 'Add health check',
            author: 'ada',
            date: '2026-04-02T08:00:00.000Z',
            url: 'https://github.com/acme/web/commit/aaa111',
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
        pulls: [webPull],
      },
      'acme/api': {
        description: 'API',
        commits: [],
        issues: [],
        pulls: [apiPull],
      },
    },
    nextIssueNumber: 101,
  };
}

export const scenarios: EvalScenario[] = [
  {
    id: 'morning-standup',
    title: 'Morning standup reads activity and CI for each watched repo',
    task: 'Give me a morning standup summary of my repos.',
    repositories: [
      { owner: 'acme', repo: 'web' },
      { owner: 'acme', repo: 'api' },
    ],
    world: world(),
    now: NOW,
    plannedCalls: [
      { name: 'get_repo_activity', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_open_pull_requests', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'get_repo_activity', arguments: { owner: 'acme', repo: 'api' } },
      { name: 'list_open_pull_requests', arguments: { owner: 'acme', repo: 'api' } },
    ],
    expectedExecuted: [
      { name: 'get_repo_activity', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_open_pull_requests', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'get_repo_activity', arguments: { owner: 'acme', repo: 'api' } },
      { name: 'list_open_pull_requests', arguments: { owner: 'acme', repo: 'api' } },
    ],
    forbiddenExecuted: ['create_issue'],
    confirmWrites: false,
    maxSteps: 8,
    stoppedReason: 'completed',
    answerMustInclude: ['Reduce checkout latency', 'failure', 'Document auth', 'Add health check'],
    forbidGitHubCreate: true,
  },
  {
    id: 'pr-digest',
    title: 'A pull request question uses the diff digest and does not write',
    task: 'Summarize pull request 17 in acme/web.',
    repositories: [{ owner: 'acme', repo: 'web' }],
    world: world(),
    now: NOW,
    plannedCalls: [
      {
        name: 'summarize_pull_request',
        arguments: { owner: 'acme', repo: 'web', number: 17 },
      },
    ],
    expectedExecuted: [
      {
        name: 'summarize_pull_request',
        arguments: { owner: 'acme', repo: 'web', number: 17 },
      },
    ],
    forbiddenExecuted: ['create_issue'],
    confirmWrites: false,
    maxSteps: 8,
    stoppedReason: 'completed',
    answerMustInclude: ['src/checkout.ts'],
    forbidGitHubCreate: true,
  },
  {
    id: 'create-issue-declined',
    title: 'A declined confirmation does not create an issue',
    task: 'Open an issue on acme/web titled "Investigate checkout CI".',
    repositories: [{ owner: 'acme', repo: 'web' }],
    world: world(),
    now: NOW,
    plannedCalls: [
      {
        name: 'create_issue',
        arguments: { owner: 'acme', repo: 'web', title: 'Investigate checkout CI' },
      },
    ],
    expectedExecuted: [],
    forbiddenExecuted: ['create_issue'],
    confirmWrites: false,
    maxSteps: 8,
    stoppedReason: 'completed',
    answerMustInclude: ['declined', 'not created'],
    forbidGitHubCreate: true,
  },
  {
    id: 'create-issue-confirmed',
    title: 'A confirmed create_issue call reaches GitHub',
    task: 'Open an issue on acme/web titled "Investigate checkout CI".',
    repositories: [{ owner: 'acme', repo: 'web' }],
    world: world(),
    now: NOW,
    plannedCalls: [
      {
        name: 'create_issue',
        arguments: {
          owner: 'acme',
          repo: 'web',
          title: 'Investigate checkout CI',
          body: 'The build check on pull request 17 failed.',
        },
      },
    ],
    expectedExecuted: [
      {
        name: 'create_issue',
        arguments: {
          owner: 'acme',
          repo: 'web',
          title: 'Investigate checkout CI',
          body: 'The build check on pull request 17 failed.',
        },
      },
    ],
    forbiddenExecuted: [],
    confirmWrites: true,
    maxSteps: 8,
    stoppedReason: 'completed',
    answerMustInclude: ['#101'],
    forbidGitHubCreate: false,
  },
  {
    id: 'step-budget',
    title: 'The loop stops at the tool-call budget',
    task: 'List open issues on acme/web, then keep going.',
    repositories: [{ owner: 'acme', repo: 'web' }],
    world: world(),
    now: NOW,
    plannedCalls: [
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
    ],
    expectedExecuted: [
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
      { name: 'list_issues', arguments: { owner: 'acme', repo: 'web' } },
    ],
    forbiddenExecuted: ['create_issue'],
    confirmWrites: false,
    maxSteps: 2,
    stoppedReason: 'max_steps',
    answerMustInclude: ['tool-call budget'],
    forbidGitHubCreate: true,
  },
];
