import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';

import { z } from 'zod';

import { GitHubAppAuthError, scrubSecrets } from './errors.js';

/** GitHub rejects an iat more than 60 seconds behind its clock. */
const JWT_IAT_SKEW_SECONDS = 60;
/**
 * Lifetime measured from iat. 9 minutes keeps exp under GitHub's 10-minute cap
 * both from iat and from now, because iat itself is 60 seconds in the past.
 */
const JWT_LIFETIME_SECONDS = 9 * 60;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

export type InstallationAccessTokenSourceOptions = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  now?: () => Date;
  refreshSkewMs?: number;
  extraSecrets?: readonly string[];
};

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

/**
 * Mints and caches a GitHub App installation access token.
 * The private key, the JWT, and the installation token are not included in errors.
 */
export class InstallationAccessTokenSource {
  readonly #appId: string;
  readonly #installationId: string;
  readonly #privateKey: KeyObject;
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => Date;
  readonly #refreshSkewMs: number;
  readonly #secrets = new SecretBag();
  #cached: CachedToken | null = null;
  #inflight: Promise<string> | null = null;

  constructor(options: InstallationAccessTokenSourceOptions) {
    const pem = options.privateKeyPem.replace(/\r\n/g, '\n').trim();
    this.#privateKey = readAppPrivateKey(pem);
    this.#secrets.addPem(pem);
    for (const extra of options.extraSecrets ?? []) this.#secrets.add(extra);
    this.#appId = options.appId;
    this.#installationId = options.installationId;
    this.#baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.#userAgent = options.userAgent ?? 'devops-mcp';
    this.#now = options.now ?? (() => new Date());
    this.#refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  [inspect.custom](): string {
    return `InstallationAccessTokenSource { appId: ${this.#appId}, installationId: ${this.#installationId} }`;
  }

  scrub(text: string): string {
    return this.#secrets.scrub(text);
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAtMs - this.#now().getTime() > this.#refreshSkewMs) {
      return cached.token;
    }
    if (!this.#inflight) {
      this.#inflight = this.#exchange().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async #exchange(): Promise<string> {
    const jwt = this.#jwt();
    const path = `/app/installations/${encodeURIComponent(this.#installationId)}/access_tokens`;
    const url = new URL(this.#baseUrl + path);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': this.#userAgent,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network request failed';
      throw new GitHubAppAuthError(`GitHub App token request failed: ${this.scrub(message)}`);
    }

    const raw = await response.text();
    this.#captureToken(raw);
    let payload: unknown = null;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new GitHubAppAuthError(
          `GitHub App token response was not valid JSON (HTTP ${response.status}).`,
        );
      }
    }

    if (!response.ok) {
      throw new GitHubAppAuthError(this.#failureMessage(response.status, payload));
    }

    const parsed = installationTokenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GitHubAppAuthError('GitHub App token response did not match the expected shape.');
    }

    const expiresAtMs = Date.parse(parsed.data.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new GitHubAppAuthError('GitHub App token response had an invalid expires_at.');
    }

    this.#secrets.add(parsed.data.token);
    this.#cached = { token: parsed.data.token, expiresAtMs };
    return parsed.data.token;
  }

  #jwt(): string {
    const nowSeconds = Math.floor(this.#now().getTime() / 1000);
    const iat = nowSeconds - JWT_IAT_SKEW_SECONDS;
    try {
      const jwt = signRs256Jwt(
        { iat, exp: iat + JWT_LIFETIME_SECONDS, iss: this.#appId },
        this.#privateKey,
      );
      this.#secrets.add(jwt);
      for (const part of jwt.split('.')) this.#secrets.add(part);
      return jwt;
    } catch {
      throw new GitHubAppAuthError(
        'Could not sign the GitHub App JWT. Check that the private key is a PEM RSA key.',
      );
    }
  }

  #captureToken(raw: string): void {
    try {
      const payload: unknown = JSON.parse(raw);
      if (typeof payload === 'object' && payload !== null && 'token' in payload) {
        const token = (payload as { token?: unknown }).token;
        if (typeof token === 'string') this.#secrets.add(token);
      }
    } catch {
      // Not JSON. Callers must not copy the raw body into an error.
    }
  }

  #failureMessage(status: number, payload: unknown): string {
    const detail = githubMessage(payload);
    const suffix = detail ? `: ${this.scrub(truncate(detail, 400))}` : '';
    if (status === 401) {
      return `GitHub rejected the App credentials while creating an installation token (HTTP 401)${suffix}. Check GITHUB_APP_ID, the private key, and GITHUB_APP_INSTALLATION_ID. Do not paste them into the chat.`;
    }
    if (status === 404) {
      return `GitHub could not find installation ${this.#installationId} for this App (HTTP 404)${suffix}.`;
    }
    return `GitHub App token exchange failed (HTTP ${status})${suffix}.`;
  }
}

export function readAppPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('GitHub App private key could not be parsed. Expected a PEM RSA private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('GitHub App private key must be an RSA key. GitHub App JWTs use RS256.');
  }
  return key;
}

function signRs256Jwt(
  payload: { readonly iat: number; readonly exp: number; readonly iss: string },
  key: KeyObject,
): string {
  const encodedHeader = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

class SecretBag {
  readonly #values = new Set<string>();

  add(secret: string | null | undefined): void {
    if (typeof secret !== 'string' || secret.length < 8) return;
    this.#values.add(secret);
  }

  addPem(pem: string): void {
    this.add(pem);
    for (const line of pem.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 8 && !trimmed.includes('BEGIN') && !trimmed.includes('END')) {
        this.add(trimmed);
      }
    }
  }

  scrub(text: string): string {
    return scrubSecrets(text, [...this.#values]);
  }
}

function githubMessage(payload: unknown): string | null {
  if (typeof payload === 'object' && payload && 'message' in payload) {
    const message = payload.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
