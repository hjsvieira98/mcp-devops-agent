import { createHash } from 'node:crypto';

import { loadConfig, type AppConfig, type GitHubAppConfig } from './config.js';
import { InstallationAccessTokenSource } from './github/app-auth.js';
import { GitHubRestClient } from './github/client.js';
import { MissingGitHubTokenError } from './github/errors.js';
import type { GitHubClient } from './github/types.js';
import { createDevOpsServer } from './server/create-server.js';
import { readVersion } from './version.js';

const tokenSources = new Map<string, InstallationAccessTokenSource>();

/** Drops cached installation tokens. Tests use this so cases do not share a token. */
export function resetCachedGitHubAppTokens(): void {
  tokenSources.clear();
}

export function createRuntimeServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const version = readVersion();
  const github = createGitHubClient(config, version);
  return createDevOpsServer({
    github,
    repositories: config.repositories,
    version,
  });
}

function createGitHubClient(config: AppConfig, version: string): GitHubClient {
  const userAgent = `devops-mcp/${version}`;
  // A complete App wins over GITHUB_TOKEN. Incomplete App config already threw in loadConfig.
  if (config.githubApp) {
    const source = cachedTokenSource(config.githubApp, config.githubApiBaseUrl, userAgent, config);
    return new GitHubRestClient({
      getToken: () => source.getToken(),
      scrub: (text) => source.scrub(text),
      baseUrl: config.githubApiBaseUrl,
      userAgent,
    });
  }
  if (config.githubToken) {
    return new GitHubRestClient({
      token: config.githubToken,
      baseUrl: config.githubApiBaseUrl,
      userAgent,
    });
  }
  return new UnavailableGitHub();
}

function cachedTokenSource(
  app: GitHubAppConfig,
  baseUrl: string,
  userAgent: string,
  config: AppConfig,
): InstallationAccessTokenSource {
  const fingerprint = createHash('sha256').update(app.privateKeyPem).digest('hex');
  const tokenFingerprint = createHash('sha256')
    .update(config.githubToken ?? '')
    .digest('hex');
  const key = `${app.appId}\0${app.installationId}\0${baseUrl}\0${fingerprint}\0${tokenFingerprint}`;
  const existing = tokenSources.get(key);
  if (existing) return existing;
  const source = new InstallationAccessTokenSource({
    appId: app.appId,
    installationId: app.installationId,
    privateKeyPem: app.privateKeyPem,
    baseUrl,
    userAgent,
    extraSecrets: config.githubToken ? [config.githubToken] : [],
  });
  tokenSources.set(key, source);
  return source;
}

class UnavailableGitHub implements GitHubClient {
  listOpenPullRequests(): Promise<never> {
    return fail();
  }
  getCombinedStatus(): Promise<never> {
    return fail();
  }
  listCheckRuns(): Promise<never> {
    return fail();
  }
  getPullRequest(): Promise<never> {
    return fail();
  }
  listPullRequestFiles(): Promise<never> {
    return fail();
  }
  listIssues(): Promise<never> {
    return fail();
  }
  createIssue(): Promise<never> {
    return fail();
  }
  listCommits(): Promise<never> {
    return fail();
  }
  listRecentIssues(): Promise<never> {
    return fail();
  }
  getRepository(): Promise<never> {
    return fail();
  }
}

function fail(): Promise<never> {
  return Promise.reject(new MissingGitHubTokenError());
}
