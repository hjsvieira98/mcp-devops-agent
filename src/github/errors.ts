export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError';

  constructor() {
    super('GITHUB_TOKEN is not set.');
  }
}

export class GitHubResponseError extends Error {
  override readonly name = 'GitHubResponseError';

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`GitHub payload for ${path} did not match the expected shape: ${message}`);
  }
}

export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';

  constructor(
    readonly status: number,
    readonly path: string,
    readonly responseMessage: string,
    readonly rateLimitReset: string | null,
    readonly rateLimited: boolean,
  ) {
    super(`GitHub API ${status} for ${path}: ${responseMessage}`);
  }

  toUserMessage(): string {
    if (this.status === 401) {
      return 'GitHub rejected the token (HTTP 401). Set GITHUB_TOKEN on the MCP server process to a personal access token that can read the repository. Do not paste the token into the chat.';
    }
    if (this.rateLimited) {
      const when = this.rateLimitReset ? ` Retry after ${this.rateLimitReset}.` : '';
      return `GitHub rate limit reached for ${this.path}.${when}`;
    }
    if (this.status === 403) {
      return `GitHub refused access to ${this.path} (HTTP 403): ${this.responseMessage}`;
    }
    if (this.status === 404) {
      return `GitHub could not find ${this.path}. Check the owner, repository, and number, and that the token can see the repository.`;
    }
    if (this.status === 422) {
      return `GitHub rejected the request to ${this.path} (HTTP 422): ${this.responseMessage}`;
    }
    return `GitHub API returned HTTP ${this.status} for ${this.path}: ${this.responseMessage}`;
  }
}

export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

export function toToolErrorMessage(error: unknown): string {
  if (error instanceof MissingGitHubTokenError) {
    return 'GITHUB_TOKEN is not set on the MCP server. Add it to the server environment and restart the server. Do not paste the token into the chat.';
  }
  if (error instanceof GitHubApiError) return error.toUserMessage();
  if (error instanceof GitHubResponseError) return error.message;
  if (error instanceof Error) return `GitHub request failed: ${error.message}`;
  return 'GitHub request failed.';
}
