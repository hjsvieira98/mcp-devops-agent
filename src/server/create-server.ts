import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { WatchedRepository } from '../config.js';
import { repoResourceUri, SERVER_NAME, WATCHLIST_URI } from '../constants.js';
import { GitHubApiError, toToolErrorMessage } from '../github/errors.js';
import type { GitHubClient, IssueSummary } from '../github/types.js';
import { rollupCi } from './ci.js';
import {
  activityOutput,
  createdIssueOutput,
  issueListOutput,
  limitSchema,
  ownerRepoSchema,
  pullListOutput,
  sinceSchema,
  summaryOutput,
  type ActivityOutput,
  type CreatedIssueOutput,
  type IssueListOutput,
  type PullListOutput,
  type SummaryOutput,
} from './schemas.js';
import { firstLine, mapWithConcurrency, truncate } from './text.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export type DevOpsServerOptions = {
  github: GitHubClient;
  repositories: readonly WatchedRepository[];
  version: string;
  now?: () => Date;
};

const INSTRUCTIONS = [
  'DevOps tools for GitHub repositories the caller can already access.',
  'list_open_pull_requests, summarize_pull_request, list_issues, and get_repo_activity only read.',
  'create_issue opens an issue. Call it only after the user has explicitly asked to create one.',
  'Pass owner and repo as separate arguments, not as a URL.',
  'devops://watchlist lists repositories from the GITHUB_REPOS environment variable.',
  'Pull request digests truncate patches. Mention that when patchTruncated or filesTruncated is true.',
  'Never ask the user to paste a GitHub token into the chat. The server reads GITHUB_TOKEN from its own environment.',
].join(' ');

export function createDevOpsServer(options: DevOpsServerOptions): McpServer {
  const now = options.now ?? (() => new Date());
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_open_pull_requests',
    {
      title: 'List open pull requests',
      description:
        'List open pull requests for one repository and roll up CI. Failure wins over pending, which wins over success. An empty check set is "unknown", not passing. Returns the first page only.',
      inputSchema: ownerRepoSchema.extend({ limit: limitSchema }),
      outputSchema: pullListOutput,
      annotations: READ_ONLY,
    },
    async ({ owner, repo, limit }) =>
      runTool(async () => {
        const pageSize = limit ?? 10;
        const pulls = await options.github.listOpenPullRequests(owner, repo, pageSize);
        let checksDenied = false;
        const detailed = await mapWithConcurrency(pulls, 4, async (pull) => {
          const status = await options.github.getCombinedStatus(owner, repo, pull.headSha);
          let checks: Awaited<ReturnType<GitHubClient['listCheckRuns']>> = [];
          try {
            checks = await options.github.listCheckRuns(owner, repo, pull.headSha);
          } catch (error) {
            if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
              checksDenied = true;
            } else {
              throw error;
            }
          }
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
            ci: rollupCi(status, checks),
          };
        });
        const warnings = checksDenied
          ? [
              'GitHub denied check-run access. Combined commit statuses are included; check runs are not. The token needs permission to read checks.',
            ]
          : [];
        const structured: PullListOutput = { owner, repo, pullRequests: detailed, warnings };
        return jsonResult(renderPullList(structured), structured);
      }),
  );

  server.registerTool(
    'summarize_pull_request',
    {
      title: 'Summarize a pull request diff',
      description:
        'Fetch one pull request and return a bounded digest of its metadata, description, and diff. Patches are truncated. This tool does not call a language model; the host writes the prose from the digest.',
      inputSchema: ownerRepoSchema.extend({
        number: z.number().int().positive().max(100_000_000).describe('Pull request number'),
        fileLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum files to include. Defaults to 20.'),
        maxPatchChars: z
          .number()
          .int()
          .min(0)
          .max(20_000)
          .optional()
          .describe('Total characters of patch text to keep across all files. Defaults to 8000.'),
      }),
      outputSchema: summaryOutput,
      annotations: READ_ONLY,
    },
    async ({ owner, repo, number, fileLimit, maxPatchChars }) =>
      runTool(async () => {
        const fileCap = fileLimit ?? 20;
        const patchBudget = maxPatchChars ?? 8000;
        const [pull, files] = await Promise.all([
          options.github.getPullRequest(owner, repo, number),
          options.github.listPullRequestFiles(owner, repo, number, fileCap),
        ]);
        const body = truncate(pull.body ?? '', 1500);
        let remaining = patchBudget;
        const renderedFiles = files.map((file) => {
          if (!file.patch || remaining <= 0) {
            return {
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: null,
              patchTruncated: Boolean(file.patch),
            };
          }
          const patch = truncate(file.patch, Math.min(remaining, 1500));
          remaining -= patch.text.length;
          return {
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: patch.text,
            patchTruncated: patch.truncated,
          };
        });
        const structured: SummaryOutput = {
          owner,
          repo,
          number: pull.number,
          title: pull.title,
          url: pull.url,
          author: pull.author,
          draft: pull.draft,
          baseRef: pull.baseRef,
          headRef: pull.headRef,
          headSha: pull.headSha,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          body: body.text,
          bodyTruncated: body.truncated,
          files: renderedFiles,
          filesTruncated: files.length >= fileCap,
        };
        return jsonResult(renderSummary(structured), structured);
      }),
  );

  server.registerTool(
    'list_issues',
    {
      title: 'List issues',
      description:
        'List issues for one repository. Pull requests are omitted because GitHub returns them from the issues API. Returns the first page only, so a page that is mostly pull requests can yield fewer issues than the limit.',
      inputSchema: ownerRepoSchema.extend({
        state: z
          .enum(['open', 'closed', 'all'])
          .optional()
          .describe('Issue state. Defaults to open.'),
        limit: limitSchema,
      }),
      outputSchema: issueListOutput,
      annotations: READ_ONLY,
    },
    async ({ owner, repo, state, limit }) =>
      runTool(async () => {
        const selected = state ?? 'open';
        const issues = await options.github.listIssues(owner, repo, selected, limit ?? 10);
        const structured: IssueListOutput = {
          owner,
          repo,
          state: selected,
          issues: issues.map(toIssueView),
        };
        return jsonResult(renderIssues(structured), structured);
      }),
  );

  server.registerTool(
    'create_issue',
    {
      title: 'Create an issue',
      description:
        'Open a GitHub issue in one repository. This writes to GitHub. Call it only when the user has explicitly asked to create an issue. Creating the same issue twice creates two issues.',
      inputSchema: ownerRepoSchema.extend({
        title: z.string().trim().min(1).max(200).describe('Issue title'),
        body: z.string().max(10_000).optional().describe('Issue body in Markdown'),
        labels: z
          .array(z.string().trim().min(1).max(50))
          .max(10)
          .optional()
          .describe('Label names that already exist on the repository'),
      }),
      outputSchema: createdIssueOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ owner, repo, title, body, labels }) =>
      runTool(async () => {
        const issue = await options.github.createIssue(owner, repo, {
          title,
          ...(body === undefined ? {} : { body }),
          ...(labels === undefined ? {} : { labels }),
        });
        const structured: CreatedIssueOutput = { owner, repo, ...toIssueView(issue) };
        return jsonResult(`Created issue #${issue.number}: ${issue.url}`, structured);
      }),
  );

  server.registerTool(
    'get_repo_activity',
    {
      title: 'Get repository activity',
      description:
        'Recent commits, updated issues, and updated pull requests since a timestamp. Defaults to the last 24 hours. Returns the first page of each list only.',
      inputSchema: ownerRepoSchema.extend({ since: sinceSchema, limit: limitSchema }),
      outputSchema: activityOutput,
      annotations: READ_ONLY,
    },
    async ({ owner, repo, since, limit }) =>
      runTool(async () => {
        const until = now();
        const start = since ?? new Date(until.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const pageSize = limit ?? 10;
        const [commits, recent] = await Promise.all([
          options.github.listCommits(owner, repo, start, pageSize),
          options.github.listRecentIssues(owner, repo, start, pageSize),
        ]);
        const structured: ActivityOutput = {
          owner,
          repo,
          since: start,
          until: until.toISOString(),
          commits: commits.map((commit) => ({
            sha: commit.sha,
            message: firstLine(commit.message),
            author: commit.author,
            date: commit.date,
            url: commit.url,
          })),
          issuesUpdated: recent.filter((issue) => !issue.isPullRequest).map(toIssueBrief),
          pullRequestsUpdated: recent.filter((issue) => issue.isPullRequest).map(toIssueBrief),
        };
        return jsonResult(renderActivity(structured), structured);
      }),
  );

  server.registerResource(
    'watchlist',
    WATCHLIST_URI,
    {
      title: 'Watched repositories',
      description:
        'Repositories from the GITHUB_REPOS environment variable. Hosts that do not attach resources automatically can still read this URI.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const payload = {
        repositories: options.repositories.map((repository) => ({
          owner: repository.owner,
          repo: repository.repo,
        })),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );

  server.registerResource(
    'repository',
    new ResourceTemplate('github://repo/{owner}/{repo}', {
      list: async () => ({
        resources: options.repositories.map((repository) => ({
          uri: repoResourceUri(repository.owner, repository.repo),
          name: `${repository.owner}/${repository.repo}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Repository snapshot',
      description: 'Description, default branch, and open issue count for one repository.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const owner = single(variables.owner);
      const repo = single(variables.repo);
      const parsed = ownerRepoSchema.safeParse({ owner, repo });
      if (!parsed.success) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Invalid repository URI ${uri.href}.`,
        );
      }
      try {
        const info = await options.github.getRepository(parsed.data.owner, parsed.data.repo);
        const watched = options.repositories.some(
          (repository) => repository.owner === info.owner && repository.repo === info.repo,
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ ...info, watched }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          throw new ResourceNotFoundError(uri.href, error.toUserMessage());
        }
        throw new ProtocolError(ProtocolErrorCode.InternalError, toToolErrorMessage(error));
      }
    },
  );

  server.registerPrompt(
    'morning_standup',
    {
      title: 'Morning standup',
      description:
        'Ask the model to summarize watched repositories: recent activity, pull requests waiting on review, and CI failures.',
      argsSchema: z.object({
        focus: z
          .string()
          .max(300)
          .optional()
          .describe('Optional area to emphasize, such as a service name'),
      }),
    },
    ({ focus }) => ({
      description: 'Standup brief grounded in DevOps tools',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Prepare a morning standup for my watched repositories.',
              'Read devops://watchlist, then for each repository call get_repo_activity and list_open_pull_requests.',
              'Write four short sections: what changed, pull requests waiting for review, CI failures, and suggested next actions.',
              'Use only facts from tool results. Do not invent pull request numbers, SHAs, or CI states.',
              'If a patch or list is truncated, say so.',
              focus ? `Focus on: ${focus}` : 'No extra focus was requested.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'pr_review_brief',
    {
      title: 'Pull request review brief',
      description:
        'Ask the model to brief a reviewer on one pull request using summarize_pull_request.',
      argsSchema: z.object({
        owner: z.string().min(1).max(100).describe('Repository owner'),
        repo: z.string().min(1).max(100).describe('Repository name'),
        number: z.string().regex(/^\d+$/).describe('Pull request number'),
      }),
    },
    ({ owner, repo, number }) => ({
      description: `Review brief for ${owner}/${repo}#${number}`,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Brief me on pull request ${number} in ${owner}/${repo} before I review it.`,
              `Call summarize_pull_request with owner "${owner}", repo "${repo}", and number ${number}.`,
              'Also call list_open_pull_requests if you need the CI rollup for that pull request.',
              'Cover the intent, the files that matter, risk, and tests you would want. Quote the digest; do not invent changes that are not in it.',
              'If a patch was truncated, say which files you did not fully see.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

async function runTool(
  action: () => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: Record<string, unknown>;
  }>,
): Promise<{
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    return await action();
  } catch (error) {
    return {
      content: [{ type: 'text', text: toToolErrorMessage(error) }],
      isError: true,
    };
  }
}

function jsonResult(
  text: string,
  structured: Record<string, unknown>,
): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function toIssueView(issue: IssueSummary) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    author: issue.author,
    updatedAt: issue.updatedAt,
    labels: issue.labels,
    bodyExcerpt: truncate(issue.body ?? '', 280).text,
  };
}

function toIssueBrief(issue: IssueSummary) {
  const view = toIssueView(issue);
  return {
    number: view.number,
    title: view.title,
    url: view.url,
    state: view.state,
    author: view.author,
    updatedAt: view.updatedAt,
    labels: view.labels,
  };
}

function renderPullList(value: PullListOutput): string {
  const lines = [
    `Open pull requests in ${value.owner}/${value.repo}: ${value.pullRequests.length}`,
  ];
  for (const pull of value.pullRequests) {
    lines.push(`#${pull.number} ${pull.title} (${pull.author}) CI ${pull.ci.state} — ${pull.url}`);
    for (const check of pull.ci.checks) {
      lines.push(`  - ${check.name}: ${check.state}`);
    }
  }
  for (const warning of value.warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

function renderSummary(value: SummaryOutput): string {
  const lines = [
    `#${value.number} ${value.title}`,
    `${value.author} wants to merge ${value.headRef} (${value.headSha.slice(0, 7)}) into ${value.baseRef}`,
    `+${value.additions} / -${value.deletions} across ${value.files.length} files${value.filesTruncated ? ' (file list may be incomplete)' : ''}`,
    value.draft ? 'Draft: yes' : 'Draft: no',
    value.url,
    '',
    value.body || '(no description)',
    '',
  ];
  for (const file of value.files) {
    lines.push(`${file.filename} (${file.status}) +${file.additions} -${file.deletions}`);
    if (file.patch) lines.push(file.patch);
    else if (file.patchTruncated) lines.push('(patch omitted)');
  }
  return lines.join('\n');
}

function renderIssues(value: IssueListOutput): string {
  const lines = [`${value.state} issues in ${value.owner}/${value.repo}: ${value.issues.length}`];
  for (const issue of value.issues) {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    lines.push(`#${issue.number} ${issue.title}${labels} — ${issue.url}`);
  }
  return lines.join('\n');
}

function renderActivity(value: ActivityOutput): string {
  const lines = [`Activity in ${value.owner}/${value.repo} since ${value.since}`];
  lines.push(`Commits: ${value.commits.length}`);
  for (const commit of value.commits) {
    lines.push(`- ${commit.sha.slice(0, 7)} ${commit.message} (${commit.author})`);
  }
  lines.push(`Issues updated: ${value.issuesUpdated.length}`);
  for (const issue of value.issuesUpdated) lines.push(`- #${issue.number} ${issue.title}`);
  lines.push(`Pull requests updated: ${value.pullRequestsUpdated.length}`);
  for (const pull of value.pullRequestsUpdated) lines.push(`- #${pull.number} ${pull.title}`);
  return lines.join('\n');
}

function single(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}
