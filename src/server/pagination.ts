import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_LIST_RESULTS, MAX_PAGE_SIZE, maxListPage } from '../constants.js';
import type { IssueState } from '../github/types.js';
import { githubName, limitSchema, ownerRepoSchema } from './schemas.js';

/**
 * Process-local key. A cursor from another process, or any edited cursor, fails the signature check.
 * There is no configured secret: the server does not ask the caller to hold a signing key.
 */
const CURSOR_KEY = randomBytes(32);

export const MALFORMED_CURSOR =
  'The pagination cursor is malformed. Omit the cursor argument to read the first page.';
export const TAMPERED_CURSOR =
  'The pagination cursor is invalid or has been tampered with. Omit the cursor argument to read the first page.';
export const CURSOR_MISMATCH =
  'This pagination cursor does not match this tool, owner, repository, state, or page size. Omit the cursor argument to read the first page.';

export function cursorPastCapMessage(): string {
  return `This pagination cursor is past the maximum of ${MAX_LIST_RESULTS} results. Omit the cursor argument to read the first page.`;
}

function listCapWarning(): string {
  return `Stopped at the cap of ${MAX_LIST_RESULTS} results. This is not the last page on GitHub. Omit the cursor to start over.`;
}

const CURSOR_VERSION = 1;

export type ListKind = 'pulls' | 'issues';

export type ListCursor = {
  v: typeof CURSOR_VERSION;
  kind: ListKind;
  owner: string;
  repo: string;
  state: IssueState | null;
  limit: number;
  page: number;
};

export type CursorQuery = {
  kind: ListKind;
  owner: string;
  repo: string;
  state: IssueState | null;
  limit: number;
};

type DecodeResult = { ok: true; cursor: ListCursor } | { ok: false; message: string };

const cursorPayloadSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    kind: z.enum(['pulls', 'issues']),
    owner: githubName,
    repo: githubName,
    state: z.enum(['open', 'closed', 'all']).nullable(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
    page: z.number().int().min(2).max(MAX_LIST_RESULTS),
    mac: z.string().min(1).max(128),
  })
  .superRefine((value, ctx) => {
    const cursor = unsigned(value);
    if (!macEqual(value.mac, sign(cursor))) {
      ctx.addIssue({ code: 'custom', message: TAMPERED_CURSOR });
      return;
    }
    if (cursor.kind === 'pulls' && cursor.state !== null) {
      ctx.addIssue({ code: 'custom', message: MALFORMED_CURSOR });
    }
    if (cursor.kind === 'issues' && cursor.state === null) {
      ctx.addIssue({ code: 'custom', message: MALFORMED_CURSOR });
    }
    if (cursor.page > maxListPage(cursor.limit)) {
      ctx.addIssue({ code: 'custom', message: cursorPastCapMessage() });
    }
  });

const cursorArgument = z
  .string()
  .trim()
  .max(1024, MALFORMED_CURSOR)
  .optional()
  .describe(
    'Opaque nextCursor from a previous result for the same tool, owner, repository, state, and limit. Omit it to read the first page. Do not invent a cursor.',
  );

export const pullListArgs = ownerRepoSchema
  .extend({
    limit: limitSchema,
    cursor: cursorArgument,
  })
  .superRefine((value, ctx) => {
    rejectCursor(ctx, value.cursor, {
      kind: 'pulls',
      owner: value.owner,
      repo: value.repo,
      limit: value.limit ?? DEFAULT_PAGE_SIZE,
      state: null,
    });
  });

export const issueListArgs = ownerRepoSchema
  .extend({
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state. Defaults to open.'),
    limit: limitSchema,
    cursor: cursorArgument,
  })
  .superRefine((value, ctx) => {
    rejectCursor(ctx, value.cursor, {
      kind: 'issues',
      owner: value.owner,
      repo: value.repo,
      limit: value.limit ?? DEFAULT_PAGE_SIZE,
      state: value.state ?? 'open',
    });
  });

export class PaginationError extends Error {
  override readonly name = 'PaginationError';

  constructor(message: string) {
    super(message);
  }
}

export function encodeCursor(cursor: ListCursor): string {
  const body = { ...cursor, mac: sign(cursor) };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): DecodeResult {
  if (token.length === 0 || token.length > 1024) return { ok: false, message: MALFORMED_CURSOR };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
  } catch {
    return { ok: false, message: MALFORMED_CURSOR };
  }
  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => issue.message);
    if (messages.includes(TAMPERED_CURSOR)) return { ok: false, message: TAMPERED_CURSOR };
    const cap = messages.find((message) => message === cursorPastCapMessage());
    if (cap) return { ok: false, message: cap };
    return { ok: false, message: MALFORMED_CURSOR };
  }
  return { ok: true, cursor: unsigned(parsed.data) };
}

export function cursorMatches(cursor: ListCursor, query: CursorQuery): boolean {
  return (
    cursor.kind === query.kind &&
    cursor.owner === query.owner &&
    cursor.repo === query.repo &&
    cursor.state === query.state &&
    cursor.limit === query.limit
  );
}

/** Page to request. The first page is 1 when the caller omits the cursor. */
export function pageToFetch(cursor: string | undefined, query: CursorQuery): number {
  if (cursor === undefined) return 1;
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) throw new PaginationError(decoded.message);
  if (!cursorMatches(decoded.cursor, query)) throw new PaginationError(CURSOR_MISMATCH);
  return decoded.cursor.page;
}

export function finishPage(input: CursorQuery & { hasMore: boolean; page: number }): {
  nextCursor: string | null;
  capWarning: string | null;
} {
  if (!input.hasMore) return { nextCursor: null, capWarning: null };
  const nextPage = input.page + 1;
  if (nextPage > maxListPage(input.limit)) {
    return { nextCursor: null, capWarning: listCapWarning() };
  }
  return {
    nextCursor: encodeCursor({
      v: CURSOR_VERSION,
      kind: input.kind,
      owner: input.owner,
      repo: input.repo,
      state: input.state,
      limit: input.limit,
      page: nextPage,
    }),
    capWarning: null,
  };
}

function rejectCursor(ctx: z.RefinementCtx, cursor: string | undefined, query: CursorQuery): void {
  if (cursor === undefined) return;
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) {
    ctx.addIssue({ code: 'custom', path: ['cursor'], message: decoded.message });
    return;
  }
  if (!cursorMatches(decoded.cursor, query)) {
    ctx.addIssue({ code: 'custom', path: ['cursor'], message: CURSOR_MISMATCH });
  }
}

function unsigned(value: {
  v: 1;
  kind: ListKind;
  owner: string;
  repo: string;
  state: IssueState | null;
  limit: number;
  page: number;
}): ListCursor {
  return {
    v: value.v,
    kind: value.kind,
    owner: value.owner,
    repo: value.repo,
    state: value.state,
    limit: value.limit,
    page: value.page,
  };
}

function canonical(cursor: ListCursor): string {
  return JSON.stringify({
    v: cursor.v,
    kind: cursor.kind,
    owner: cursor.owner,
    repo: cursor.repo,
    state: cursor.state,
    limit: cursor.limit,
    page: cursor.page,
  });
}

function sign(cursor: ListCursor): string {
  return createHmac('sha256', CURSOR_KEY).update(canonical(cursor)).digest('base64url');
}

function macEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
