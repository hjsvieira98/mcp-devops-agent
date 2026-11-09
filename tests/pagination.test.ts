import { describe, expect, it } from 'vitest';

import { maxListPage } from '../src/constants.js';
import {
  CURSOR_MISMATCH,
  MALFORMED_CURSOR,
  TAMPERED_CURSOR,
  cursorPastCapMessage,
  decodeCursor,
  encodeCursor,
  finishPage,
  issueListArgs,
  pullListArgs,
  type ListCursor,
} from '../src/server/pagination.js';

const pullsCursor = (page: number, limit = 10): ListCursor => ({
  v: 1,
  kind: 'pulls',
  owner: 'acme',
  repo: 'web',
  state: null,
  limit,
  page,
});

function rewritePage(token: string, page: number): string {
  const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { page: number };
  json.page = page;
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
}

describe('pagination cursors', () => {
  it('round-trips a cursor and rejects a malformed token', () => {
    const token = encodeCursor(pullsCursor(2));
    expect(decodeCursor(token)).toEqual({ ok: true, cursor: pullsCursor(2) });
    expect(decodeCursor('not-a-cursor')).toEqual({ ok: false, message: MALFORMED_CURSOR });
    expect(decodeCursor('')).toEqual({ ok: false, message: MALFORMED_CURSOR });
    expect(decodeCursor(Buffer.from('{', 'utf8').toString('base64url'))).toEqual({
      ok: false,
      message: MALFORMED_CURSOR,
    });
  });

  it('rejects a cursor whose page was edited', () => {
    const token = encodeCursor(pullsCursor(2));
    const decoded = decodeCursor(rewritePage(token, 3));
    expect(decoded).toEqual({ ok: false, message: TAMPERED_CURSOR });
  });

  it('rejects a signed cursor that would pass the result cap', () => {
    expect(maxListPage(30)).toBe(3);
    const token = encodeCursor(pullsCursor(4, 30));
    expect(decodeCursor(token)).toEqual({ ok: false, message: cursorPastCapMessage() });
  });

  it('validates tool arguments with Zod before a caller can use the cursor', () => {
    const token = encodeCursor(pullsCursor(2));
    expect(
      pullListArgs.safeParse({ owner: 'acme', repo: 'web', limit: 10, cursor: token }).success,
    ).toBe(true);
    expect(pullListArgs.safeParse({ owner: 'acme', repo: 'web', cursor: token }).success).toBe(
      true,
    );

    const wrongState = issueListArgs.safeParse({
      owner: 'acme',
      repo: 'web',
      state: 'closed',
      limit: 10,
      cursor: encodeCursor({
        v: 1,
        kind: 'issues',
        owner: 'acme',
        repo: 'web',
        state: 'open',
        limit: 10,
        page: 2,
      }),
    });
    expect(wrongState.success).toBe(false);
    if (!wrongState.success) {
      expect(wrongState.error.issues.map((issue) => issue.message)).toContain(CURSOR_MISMATCH);
    }

    const tampered = pullListArgs.safeParse({
      owner: 'acme',
      repo: 'web',
      limit: 10,
      cursor: rewritePage(token, 3),
    });
    expect(tampered.success).toBe(false);
    if (!tampered.success) {
      expect(tampered.error.issues.map((issue) => issue.message)).toContain(TAMPERED_CURSOR);
    }

    const mismatched = pullListArgs.safeParse({
      owner: 'acme',
      repo: 'web',
      limit: 5,
      cursor: token,
    });
    expect(mismatched.success).toBe(false);
    if (!mismatched.success) {
      expect(mismatched.error.issues.map((issue) => issue.message)).toContain(CURSOR_MISMATCH);
    }

    const malformed = issueListArgs.safeParse({
      owner: 'acme',
      repo: 'web',
      cursor: '%%%',
    });
    expect(malformed.success).toBe(false);
    if (!malformed.success) {
      expect(malformed.error.issues.map((issue) => issue.message)).toContain(MALFORMED_CURSOR);
    }
  });

  it('returns a next cursor only when another page fits under the cap', () => {
    const query = {
      kind: 'issues' as const,
      owner: 'acme',
      repo: 'web',
      state: 'open' as const,
      limit: 10,
      page: 1,
    };
    expect(finishPage({ ...query, hasMore: false })).toEqual({
      nextCursor: null,
      capWarning: null,
    });
    const next = finishPage({ ...query, hasMore: true });
    expect(next.capWarning).toBeNull();
    expect(decodeCursor(next.nextCursor ?? '')).toEqual({
      ok: true,
      cursor: {
        v: 1,
        kind: 'issues',
        owner: 'acme',
        repo: 'web',
        state: 'open',
        limit: 10,
        page: 2,
      },
    });
    const capped = finishPage({ ...query, limit: 30, page: 3, hasMore: true });
    expect(capped.nextCursor).toBeNull();
    expect(capped.capWarning).toMatch(/100/);
  });
});
