import { readFileSync, statSync, type Stats } from 'node:fs';

import { DEFAULT_HTTP_PORT } from './constants.js';
import { readAppPrivateKey } from './github/app-auth.js';

export type WatchedRepository = {
  owner: string;
  repo: string;
};

export type GitHubAppConfig = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
};

export type AppConfig = {
  githubToken: string | null;
  githubApp: GitHubAppConfig | null;
  githubApiBaseUrl: string;
  repositories: WatchedRepository[];
  httpPort: number;
};

export type GitHubAuthMode = 'app' | 'pat' | 'none';

/** Variables copied into the MCP server child. Model keys are not in this list. */
export const GITHUB_SERVER_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_REPOS',
  'GITHUB_API_BASE_URL',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
] as const;

const MAX_APP_PRIVATE_KEY_BYTES = 64 * 1024;

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

export function resolveGitHubAuth(config: AppConfig): GitHubAuthMode {
  if (config.githubApp) return 'app';
  if (config.githubToken) return 'pat';
  return 'none';
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const token = env.GITHUB_TOKEN?.trim() ?? '';
  const githubApp = loadGitHubApp(env);
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
    githubApp,
    githubApiBaseUrl: parsedBase.origin + parsedBase.pathname.replace(/\/+$/, ''),
    repositories,
    httpPort,
  };
}

function loadGitHubApp(env: NodeJS.ProcessEnv): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim() ?? '';
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim() ?? '';
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim() ?? '';
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() ?? '';
  const anySet = [appId, installationId, privateKey, privateKeyPath].some(
    (value) => value.length > 0,
  );
  if (!anySet) return null;

  if (privateKey && privateKeyPath) {
    throw new Error(
      'Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH, not both. Refusing to start with an ambiguous GitHub App configuration.',
    );
  }

  const missing: string[] = [];
  if (!appId) missing.push('GITHUB_APP_ID');
  if (!installationId) missing.push('GITHUB_APP_INSTALLATION_ID');
  if (!privateKey && !privateKeyPath) {
    missing.push('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
  }
  if (missing.length > 0) {
    throw new Error(
      `GitHub App configuration is incomplete. Missing ${missing.join(', ')}. The server will not fall back to GITHUB_TOKEN while any GitHub App variable is set.`,
    );
  }

  const checkedAppId = requirePositiveInteger('GITHUB_APP_ID', appId);
  const checkedInstallationId = requirePositiveInteger(
    'GITHUB_APP_INSTALLATION_ID',
    installationId,
  );
  const pem = privateKey
    ? normalizePrivateKeyPem(privateKey)
    : normalizePrivateKeyPem(readPrivateKeyFile(privateKeyPath));
  readAppPrivateKey(pem);
  return {
    appId: checkedAppId,
    installationId: checkedInstallationId,
    privateKeyPem: pem,
  };
}

function requirePositiveInteger(name: string, value: string): string {
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function normalizePrivateKeyPem(value: string): string {
  let pem = value.trim();
  if (
    pem.length >= 2 &&
    ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'")))
  ) {
    pem = pem.slice(1, -1).trim();
  }
  return pem.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').trim();
}

function readPrivateKeyFile(filePath: string): string {
  const label = describePath(filePath);
  const info = statPrivateKey(filePath, label);
  if (!info.isFile()) {
    throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH is not a file (${label}).`);
  }
  if (info.size > MAX_APP_PRIVATE_KEY_BYTES) {
    throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH is too large to be a PEM private key (${label}).`);
  }
  return readPrivateKeyText(filePath, label);
}

function statPrivateKey(filePath: string, label: string): Stats {
  try {
    return statSync(filePath);
  } catch {
    // The filesystem error can repeat the path. Drop it so a path that is itself key material cannot leak.
    throw new Error(`Could not read GITHUB_APP_PRIVATE_KEY_PATH (${label}).`);
  }
}

function readPrivateKeyText(filePath: string, label: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`Could not read GITHUB_APP_PRIVATE_KEY_PATH (${label}).`);
  }
}

function describePath(filePath: string): string {
  if (
    filePath.length > 1024 ||
    filePath.includes('\n') ||
    filePath.includes('-----') ||
    /PRIVATE KEY/i.test(filePath)
  ) {
    return 'the configured path';
  }
  return filePath;
}
