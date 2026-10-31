import { DEFAULT_HTTP_PORT } from './constants.js';

export type WatchedRepository = {
  owner: string;
  repo: string;
};

export type AppConfig = {
  githubToken: string | null;
  githubApiBaseUrl: string;
  repositories: WatchedRepository[];
  httpPort: number;
};

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function parseRepositorySlug(slug: string): WatchedRepository {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected owner/repo, received "${slug}".`);
  }
  const [owner, repo] = parts;
  if (!NAME.test(owner) || !NAME.test(repo) || owner.includes('..') || repo.includes('..')) {
    throw new Error(`"${slug}" is not a valid GitHub owner/repo.`);
  }
  return { owner, repo };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const token = env.GITHUB_TOKEN?.trim() ?? '';
  const base = (env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com').replace(/\/+$/, '');
  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error(`GITHUB_API_BASE_URL is not a valid URL: ${base}`);
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    throw new Error('GITHUB_API_BASE_URL must use http or https.');
  }

  const repositories = (env.GITHUB_REPOS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseRepositorySlug(entry));

  const portRaw = env.MCP_HTTP_PORT?.trim() || String(DEFAULT_HTTP_PORT);
  const httpPort = Number(portRaw);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error('MCP_HTTP_PORT must be an integer from 1 to 65535.');
  }

  return {
    githubToken: token.length > 0 ? token : null,
    githubApiBaseUrl: parsedBase.origin + parsedBase.pathname.replace(/\/+$/, ''),
    repositories,
    httpPort,
  };
}
