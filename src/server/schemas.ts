import { z } from 'zod';

const githubName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    'Expected a GitHub owner or repository name',
  )
  .refine((value) => !value.includes('..'), 'Names cannot contain ".."');

export const ownerRepoSchema = z.object({
  owner: githubName.describe('GitHub user or organization login'),
  repo: githubName.describe('Repository name, without the owner'),
});

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(30)
  .optional()
  .describe(
    'Maximum number of items to return. Defaults to 10. The tool returns the first page only.',
  );

export const sinceSchema = z
  .string()
  .optional()
  .describe('ISO-8601 start of the window. Defaults to 24 hours before the server clock.')
  .refine((value) => value === undefined || !Number.isNaN(Date.parse(value)), {
    message: 'Expected an ISO-8601 date or datetime',
  });

export const ciCheckSchema = z.object({
  name: z.string(),
  state: z.enum(['success', 'failure', 'pending', 'neutral']),
  url: z.string().nullable(),
});

export const pullListOutput = z.object({
  owner: z.string(),
  repo: z.string(),
  pullRequests: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      author: z.string(),
      draft: z.boolean(),
      headRef: z.string(),
      headSha: z.string(),
      baseRef: z.string(),
      updatedAt: z.string(),
      ci: z.object({
        state: z.enum(['success', 'failure', 'pending', 'neutral', 'unknown']),
        checks: z.array(ciCheckSchema),
      }),
    }),
  ),
  warnings: z.array(z.string()),
});

export const summaryOutput = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  files: z.array(
    z.object({
      filename: z.string(),
      status: z.string(),
      additions: z.number().int(),
      deletions: z.number().int(),
      patch: z.string().nullable(),
      patchTruncated: z.boolean(),
    }),
  ),
  filesTruncated: z.boolean(),
});

export const issueOutput = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
  bodyExcerpt: z.string(),
});

export const issueListOutput = z.object({
  owner: z.string(),
  repo: z.string(),
  state: z.enum(['open', 'closed', 'all']),
  issues: z.array(issueOutput),
});

export const createdIssueOutput = issueOutput.extend({
  owner: z.string(),
  repo: z.string(),
});

export const activityOutput = z.object({
  owner: z.string(),
  repo: z.string(),
  since: z.string(),
  until: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      message: z.string(),
      author: z.string(),
      date: z.string(),
      url: z.string(),
    }),
  ),
  issuesUpdated: z.array(issueOutput.omit({ bodyExcerpt: true })),
  pullRequestsUpdated: z.array(issueOutput.omit({ bodyExcerpt: true })),
});

export type PullListOutput = z.infer<typeof pullListOutput>;
export type SummaryOutput = z.infer<typeof summaryOutput>;
export type IssueListOutput = z.infer<typeof issueListOutput>;
export type CreatedIssueOutput = z.infer<typeof createdIssueOutput>;
export type ActivityOutput = z.infer<typeof activityOutput>;
