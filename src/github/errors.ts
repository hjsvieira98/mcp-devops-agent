export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError';

  constructor() {
    super('No GitHub credential is set.');
  }
}

export class GitHubAppAuthError extends Error {
  override readonly name = 'GitHubAppAuthError';

  constructor(message: string) {
    super(message);
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
      return 'GitHub rejected the credential (HTTP 401). On the MCP server process, set GITHUB_TOKEN or a complete GitHub App (GITHUB_APP_ID, a private key, and GITHUB_APP_INSTALLATION_ID). Do not paste a token or private key into the chat.';
    }
    if (this.rateLimited) {
      const when = this.rateLimitReset ? ` Retry after ${this.rateLimitReset}.` : '';
      return `GitHub rate limit reached for ${this.path}.${when}`;
    }
    if (this.status === 403) {
      return `GitHub refused access to ${this.path} (HTTP 403): ${this.responseMessage}`;
    }
    if (this.status === 404) {
      return `GitHub could not find ${this.path}. Check the owner, repository, and number, and that the credential can see the repository.`;
    }
    if (this.status === 422) {
      return `GitHub rejected the request to ${this.path} (HTTP 422): ${this.responseMessage}`;
    }
    return `GitHub API returned HTTP ${this.status} for ${this.path}: ${this.responseMessage}`;
  }
}

export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return scrubSecrets(text, [secret]);
}

export function scrubSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  const unique = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))].sort(
    (left, right) => right.length - left.length,
  );
  let out = text;
  for (const secret of unique) out = out.split(secret).join('[redacted]');
  return out;
}

export function toToolErrorMessage(error: unknown): string {
  if (error instanceof MissingGitHubTokenError) {
    return 'No GitHub credential is set on the MCP server. Set GITHUB_TOKEN, or GITHUB_APP_ID with a private key and GITHUB_APP_INSTALLATION_ID, then restart the server. Do not paste a token or private key into the chat.';
  }
  if (error instanceof GitHubAppAuthError) return error.message;
  if (error instanceof GitHubApiError) return error.toUserMessage();
  if (error instanceof GitHubResponseError) return error.message;
  if (error instanceof Error) return `GitHub request failed: ${error.message}`;
  return 'GitHub request failed.';
}
