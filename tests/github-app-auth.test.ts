import { createVerify } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallationAccessTokenSource } from '../src/github/app-auth.js';
import { GitHubAppAuthError } from '../src/github/errors.js';
import { resetCachedGitHubAppTokens, createRuntimeServer } from '../src/runtime.js';
import { generateTestAppKey, jsonResponse, withClient } from './helpers.js';

const START = Date.parse('2026-06-01T00:00:00.000Z');
const APP_ID = '12345';
const INSTALLATION_ID = '456';

describe('GitHub App installation tokens', () => {
  const { privateKeyPem, publicKeyPem } = generateTestAppKey();

  beforeEach(() => {
    resetCachedGitHubAppTokens();
  });

  it('signs an RS256 JWT and exchanges it for a cached installation token', async () => {
    let fetches = 0;
    let authorization = '';
    let method = '';
    let requestUrl = '';
    let accept = '';
    let userAgent = '';
    let apiVersion = '';
    let body: unknown;
    const source = new InstallationAccessTokenSource({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem,
      baseUrl: 'https://api.github.test/api/v3',
      userAgent: 'devops-mcp-test',
      now: () => new Date(START),
      fetch: async (input, init) => {
        fetches += 1;
        requestUrl = input instanceof URL ? input.href : String(input);
        method = init?.method ?? '';
        body = init?.body;
        const headers = new Headers(init?.headers);
        authorization = headers.get('authorization') ?? '';
        accept = headers.get('accept') ?? '';
        userAgent = headers.get('user-agent') ?? '';
        apiVersion = headers.get('x-github-api-version') ?? '';
        return jsonResponse(
          {
            token: 'ghs_installation_token_one',
            expires_at: new Date(START + 3_600_000).toISOString(),
            permissions: { issues: 'write', metadata: 'read', pull_requests: 'read' },
            repository_selection: 'selected',
          },
          201,
        );
      },
    });

    await expect(source.getToken()).resolves.toBe('ghs_installation_token_one');
    await expect(source.getToken()).resolves.toBe('ghs_installation_token_one');
    expect(fetches).toBe(1);
    expect(method).toBe('POST');
    expect(body).toBeUndefined();
    expect(requestUrl).toBe('https://api.github.test/api/v3/app/installations/456/access_tokens');
    expect(accept).toBe('application/vnd.github+json');
    expect(userAgent).toBe('devops-mcp-test');
    expect(apiVersion).toBe('2022-11-28');

    const jwt = authorization.replace(/^Bearer /, '');
    expect(authorization).toBe(`Bearer ${jwt}`);
    expect(jwt.split('.')).toHaveLength(3);
    const parts = jwt.split('.');
    const encodedHeader = parts[0];
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error('JWT was missing a segment.');
    }
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      alg: string;
      typ: string;
    };
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss']);
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(Math.floor(START / 1000) - 60);
    expect(payload.exp).toBe(payload.iat + 9 * 60);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify(publicKeyPem, encodedSignature, 'base64url')).toBe(true);
    expect(jwt).not.toContain('PRIVATE KEY');
  });

  it('refreshes when a minute or less of lifetime remains', async () => {
    let now = START;
    let generation = 0;
    const source = new InstallationAccessTokenSource({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem,
      baseUrl: 'https://api.github.test',
      now: () => new Date(now),
      fetch: async () => {
        generation += 1;
        const expiresAt = generation === 1 ? START + 3_600_000 : START + 7_200_000;
        return jsonResponse(
          {
            token: `ghs_cached_token_generation_${generation}_xxxx`,
            expires_at: new Date(expiresAt).toISOString(),
          },
          201,
        );
      },
    });

    await expect(source.getToken()).resolves.toBe('ghs_cached_token_generation_1_xxxx');
    now = START + 3_539_000;
    await expect(source.getToken()).resolves.toBe('ghs_cached_token_generation_1_xxxx');
    expect(generation).toBe(1);
    now = START + 3_540_000;
    await expect(source.getToken()).resolves.toBe('ghs_cached_token_generation_2_xxxx');
    expect(generation).toBe(2);
    await expect(source.getToken()).resolves.toBe('ghs_cached_token_generation_2_xxxx');
    expect(generation).toBe(2);
  });

  it('shares one token exchange across concurrent callers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const source = new InstallationAccessTokenSource({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem,
      baseUrl: 'https://api.github.test',
      fetch: async () => {
        calls += 1;
        await gate;
        return jsonResponse(
          {
            token: 'ghs_shared_token_abcdefghij',
            expires_at: new Date(START + 3_600_000).toISOString(),
          },
          201,
        );
      },
    });

    const first = source.getToken();
    const second = source.getToken();
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toBe('ghs_shared_token_abcdefghij');
    await expect(second).resolves.toBe('ghs_shared_token_abcdefghij');
    expect(calls).toBe(1);
  });

  it('redacts the private key, JWT, and token from exchange errors and logs', async () => {
    const pemLine = pemBodyLine(privateKeyPem);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const source = new InstallationAccessTokenSource({
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        privateKeyPem,
        baseUrl: 'https://api.github.test',
        fetch: async (_input, init) => {
          const jwt = (new Headers(init?.headers).get('authorization') ?? '').replace(
            /^Bearer /,
            '',
          );
          return jsonResponse(
            {
              token: 'ghs_leaked_from_body_zzzz',
              message: `nope ${jwt} ${pemLine} ghs_leaked_from_body_zzzz`,
            },
            401,
          );
        },
      });
      await expect(source.getToken()).rejects.toBeInstanceOf(GitHubAppAuthError);
      try {
        await source.getToken();
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
        expect(message).toContain('HTTP 401');
        expect(message).toContain('[redacted]');
        expect(message).toContain('Do not paste');
        assertRedacted(message, [pemLine, privateKeyPem, 'ghs_leaked_from_body_zzzz']);
        expect(message).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      }
      const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .map((part) => String(part))
        .join('\n');
      assertRedacted(logged, [pemLine, privateKeyPem, 'ghs_leaked_from_body_zzzz']);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('does not reuse a failed exchange or copy a non-JSON body into the error', async () => {
    let calls = 0;
    const source = new InstallationAccessTokenSource({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem,
      baseUrl: 'https://api.github.test',
      fetch: async () => {
        calls += 1;
        if (calls <= 2) {
          return jsonResponse(
            { token: 'ghs_invalid_expiry_token_zzz', expires_at: 'not-a-date' },
            201,
          );
        }
        return new Response('raw-secret-ghs_not_json_token_value', { status: 502 });
      },
    });
    try {
      await source.getToken();
      expect.fail('expected an invalid expires_at');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/invalid expires_at/);
      expect(message).not.toContain('ghs_invalid_expiry_token_zzz');
    }
    await expect(source.getToken()).rejects.toThrow(/invalid expires_at/);
    expect(calls).toBe(2);
    try {
      await source.getToken();
      expect.fail('expected a non-JSON body to fail');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/not valid JSON/);
      expect(message).not.toContain('ghs_invalid_expiry_token_zzz');
      expect(message).not.toContain('ghs_not_json_token_value');
    }
  });

  it('scrubs a network error that echoes the key and the JWT', async () => {
    const pemLine = pemBodyLine(privateKeyPem);
    const source = new InstallationAccessTokenSource({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem,
      baseUrl: 'https://api.github.test',
      fetch: async (_input, init) => {
        const jwt = new Headers(init?.headers).get('authorization') ?? '';
        throw new Error(`socket hang up ${jwt} ${pemLine}`);
      },
    });
    try {
      await source.getToken();
      expect.fail('expected a network error');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toContain('token request failed');
      assertRedacted(message, [pemLine, privateKeyPem]);
      expect(message).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    }
  });

  it('does not reveal the key or the token through inspect', async () => {
    const source = new InstallationAccessTokenSource({
      appId: '99',
      installationId: '100',
      privateKeyPem,
      baseUrl: 'https://api.github.test',
      fetch: async () =>
        jsonResponse(
          {
            token: 'ghs_hidden_install_token',
            expires_at: new Date(START + 3_600_000).toISOString(),
          },
          201,
        ),
    });
    await source.getToken();
    const dumped = inspect(source, { showHidden: true, depth: 8 });
    expect(dumped).toContain('appId: 99');
    expect(dumped).not.toContain('PRIVATE KEY');
    expect(dumped).not.toContain('ghs_hidden_install_token');
    expect(JSON.stringify(source)).not.toContain('PRIVATE');
    expect(JSON.stringify(source)).not.toContain('ghs_hidden_install_token');
  });
});

describe('runtime credential selection', () => {
  const { privateKeyPem } = generateTestAppKey();
  const pemLine = pemBodyLine(privateKeyPem);
  const installationToken = 'ghs_runtime_install_token_abcdef';
  const personalToken = 'ghp_personal_access_token_value';

  beforeEach(() => {
    resetCachedGitHubAppTokens();
  });

  it('keeps the personal access token when no App variable is set', async () => {
    const seen: string[] = [];
    await withFetch(
      async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return issueResponse();
      },
      async () => {
        const server = createRuntimeServer({
          GITHUB_TOKEN: personalToken,
          GITHUB_REPOS: 'acme/web',
        });
        await withClient(server, async (client) => {
          const result = await client.callTool({
            name: 'list_issues',
            arguments: { owner: 'acme', repo: 'web' },
          });
          expect(result.isError).toBeUndefined();
          expect(toolText(result)).toContain('A bug');
        });
      },
    );
    expect(seen).toEqual([`Bearer ${personalToken}`]);
    expect(seen.join('\n')).not.toContain('access_tokens');
  });

  it('serves tools with a cached App token and ignores a personal access token', async () => {
    const requests: { url: string; authorization: string; body: string }[] = [];
    await withFetch(
      async (input, init) => {
        const url = input instanceof URL ? input.href : String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization') ?? '',
          body: typeof init?.body === 'string' ? init.body : '',
        });
        if (url.includes('/access_tokens')) {
          return jsonResponse(
            {
              token: installationToken,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              permissions: { issues: 'read' },
              repository_selection: 'selected',
            },
            201,
          );
        }
        return issueResponse();
      },
      async () => {
        const env = {
          GITHUB_TOKEN: personalToken,
          GITHUB_APP_ID: '12345',
          GITHUB_APP_INSTALLATION_ID: '77',
          GITHUB_APP_PRIVATE_KEY: privateKeyPem,
          GITHUB_REPOS: 'acme/web',
        };
        const first = createRuntimeServer(env);
        await withClient(first, async (client) => {
          const result = await client.callTool({
            name: 'list_issues',
            arguments: { owner: 'acme', repo: 'web' },
          });
          expect(result.isError).toBeUndefined();
          expect(toolText(result)).toContain('#2');
        });
        const second = createRuntimeServer(env);
        await withClient(second, async (client) => {
          const result = await client.callTool({
            name: 'list_issues',
            arguments: { owner: 'acme', repo: 'web' },
          });
          expect(toolText(result)).toContain('A bug');
        });
      },
    );

    const exchanges = requests.filter((request) => request.url.includes('/access_tokens'));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.url).toContain('/app/installations/77/access_tokens');
    const jwt = (exchanges[0]?.authorization ?? '').replace(/^Bearer /, '');
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { iss: string };
    expect(payload.iss).toBe('12345');
    const apiCalls = requests.filter((request) => !request.url.includes('/access_tokens'));
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      expect(call.authorization).toBe(`Bearer ${installationToken}`);
      expect(call.body).not.toContain(personalToken);
    }
    const dumped = JSON.stringify(requests);
    expect(dumped).not.toContain(personalToken);
    expect(dumped).not.toContain(pemLine);
  });

  it('returns a tool error that redacts the key, JWT, installation token, and personal access token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let jwt = '';
      await withFetch(
        async (input, init) => {
          const url = input instanceof URL ? input.href : String(input);
          const authorization = new Headers(init?.headers).get('authorization') ?? '';
          if (url.includes('/access_tokens')) {
            jwt = authorization.replace(/^Bearer /, '');
            return jsonResponse(
              {
                token: installationToken,
                expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
              201,
            );
          }
          return jsonResponse(
            {
              message: `denied ${installationToken} ${jwt} ${pemLine} ${personalToken}`,
            },
            403,
          );
        },
        async () => {
          const server = createRuntimeServer({
            GITHUB_TOKEN: personalToken,
            GITHUB_APP_ID: '12345',
            GITHUB_APP_INSTALLATION_ID: '77',
            GITHUB_APP_PRIVATE_KEY: privateKeyPem,
            GITHUB_REPOS: 'acme/web',
          });
          await withClient(server, async (client) => {
            const result = await client.callTool({
              name: 'list_issues',
              arguments: { owner: 'acme', repo: 'web' },
            });
            expect(result.isError).toBe(true);
            const text = toolText(result);
            expect(text).toContain('403');
            expect(text).toContain('[redacted]');
            assertRedacted(text, [installationToken, personalToken, pemLine, privateKeyPem, jwt]);
            expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
          });
        },
      );
      const logged = errorSpy.mock.calls
        .flat()
        .map((part) => String(part))
        .join('\n');
      assertRedacted(logged, [installationToken, personalToken, pemLine, privateKeyPem]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns a startup-safe tool error when the installation token exchange is refused', async () => {
    const pemLineForExchange = pemLine;
    await withFetch(
      async (_input, init) => {
        const jwt = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
        return jsonResponse({ message: `unauthorized ${jwt} ${pemLineForExchange}` }, 401);
      },
      async () => {
        const server = createRuntimeServer({
          GITHUB_TOKEN: personalToken,
          GITHUB_APP_ID: '55',
          GITHUB_APP_INSTALLATION_ID: '66',
          GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        });
        await withClient(server, async (client) => {
          const result = await client.callTool({
            name: 'list_issues',
            arguments: { owner: 'acme', repo: 'web' },
          });
          const text = toolText(result);
          expect(result.isError).toBe(true);
          expect(text).toContain('installation token');
          expect(text).toContain('Do not paste');
          assertRedacted(text, [personalToken, pemLine, privateKeyPem]);
          expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
        });
      },
    );
  });

  it('fails startup on an incomplete App instead of calling GitHub with the personal access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await withFetch(fetchImpl, async () => {
      expect(() =>
        createRuntimeServer({
          GITHUB_TOKEN: personalToken,
          GITHUB_APP_ID: '99',
        }),
      ).toThrow(/will not fall back to GITHUB_TOKEN/);
      try {
        createRuntimeServer({
          GITHUB_TOKEN: personalToken,
          GITHUB_APP_ID: '99',
          GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        });
        expect.fail('expected incomplete installation id to throw');
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
        expect(message).toContain('GITHUB_APP_INSTALLATION_ID');
        assertRedacted(message, [personalToken, pemLine, privateKeyPem]);
      }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function pemBodyLine(pem: string): string {
  const line = pem
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length >= 20 && !entry.includes('-----'));
  if (!line) throw new Error('Test key had no PEM body line.');
  return line;
}

function assertRedacted(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
  }
}

function issueResponse(): Response {
  return jsonResponse([
    {
      number: 2,
      title: 'A bug',
      html_url: 'https://github.com/acme/web/issues/2',
      state: 'open',
      user: { login: 'ada' },
      updated_at: '2026-04-02T00:00:00Z',
      body: 'broken',
      labels: [],
    },
  ]);
}

function toolText(result: { content: unknown }): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .map((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text;
      }
      return '';
    })
    .join('\n');
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
