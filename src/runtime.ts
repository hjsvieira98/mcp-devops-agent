import { loadConfig } from './config.js';
import { GitHubRestClient } from './github/client.js';
import { MissingGitHubTokenError } from './github/errors.js';
import type { GitHubClient } from './github/types.js';
import { createDevOpsServer } from './server/create-server.js';
import { readVersion } from './version.js';

export function createRuntimeServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const version = readVersion();
  const github: GitHubClient = config.githubToken
    ? new GitHubRestClient({
        token: config.githubToken,
        baseUrl: config.githubApiBaseUrl,
        userAgent: `devops-mcp/${version}`,
      })
    : new UnavailableGitHub();
  return createDevOpsServer({
    github,
    repositories: config.repositories,
    version,
  });
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
