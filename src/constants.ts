export const SERVER_NAME = 'devops-mcp';
export const WATCHLIST_URI = 'devops://watchlist';
export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_HTTP_PORT = 3333;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

/** Default number of items in one list page. */
export const DEFAULT_PAGE_SIZE = 10;
/** Hard cap on items returned by a single list call. */
export const MAX_PAGE_SIZE = 30;
/**
 * Hard cap on items a caller can walk by following cursors.
 * Only whole pages are returned, so the total never exceeds this number.
 */
export const MAX_LIST_RESULTS = 100;

export function boundedPageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_PAGE_SIZE);
}

export function boundedPageNumber(page: number): number {
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, MAX_LIST_RESULTS);
}

/** Last 1-based page a cursor may request so whole pages stay within the total cap. */
export function maxListPage(limit: number): number {
  return Math.max(1, Math.floor(MAX_LIST_RESULTS / boundedPageSize(limit)));
}

export function repoResourceUri(owner: string, repo: string): string {
  return `github://repo/${owner}/${repo}`;
}
