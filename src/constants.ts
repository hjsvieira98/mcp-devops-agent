export const SERVER_NAME = 'devops-mcp';
export const WATCHLIST_URI = 'devops://watchlist';
export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_HTTP_PORT = 3333;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

export function repoResourceUri(owner: string, repo: string): string {
  return `github://repo/${owner}/${repo}`;
}
