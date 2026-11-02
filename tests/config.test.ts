import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, parseRepositorySlug, resolveGitHubAuth } from '../src/config.js';
import { generateTestAppKey } from './helpers.js';

describe('loadConfig', () => {
  it('parses a watchlist and ignores a blank token', () => {
    const config = loadConfig({
      GITHUB_TOKEN: '   ',
      GITHUB_REPOS: 'acme/web, other/api ',
    });
    expect(config.githubToken).toBeNull();
    expect(config.githubApp).toBeNull();
    expect(resolveGitHubAuth(config)).toBe('none');
    expect(config.repositories).toEqual([
      { owner: 'acme', repo: 'web' },
      { owner: 'other', repo: 'api' },
    ]);
    expect(config.githubApiBaseUrl).toBe('https://api.github.com');
    expect(config.httpPort).toBe(3333);
  });

  it('rejects a repository slug that is not owner/repo', () => {
    expect(() => parseRepositorySlug('acme')).toThrow(/owner\/repo/);
    expect(() => loadConfig({ GITHUB_REPOS: 'acme/web/extra' })).toThrow(/owner\/repo/);
  });

  it('rejects a non-http API base URL', () => {
    expect(() => loadConfig({ GITHUB_API_BASE_URL: 'ftp://example.com' })).toThrow(/http/);
  });

  it('uses a personal access token when no App variable is set', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'ghp_real_token',
      GITHUB_APP_ID: '   ',
      GITHUB_APP_PRIVATE_KEY: '',
      GITHUB_APP_INSTALLATION_ID: '\n',
    });
    expect(config.githubApp).toBeNull();
    expect(config.githubToken).toBe('ghp_real_token');
    expect(resolveGitHubAuth(config)).toBe('pat');
  });

  it('prefers a complete GitHub App even when a personal access token is set', () => {
    const { privateKeyPem } = generateTestAppKey();
    const config = loadConfig({
      GITHUB_TOKEN: 'ghp_real_token',
      GITHUB_APP_ID: '123',
      GITHUB_APP_INSTALLATION_ID: '456',
      GITHUB_APP_PRIVATE_KEY: `"${privateKeyPem.trim().replaceAll('\n', '\\n')}"`,
    });
    expect(config.githubToken).toBe('ghp_real_token');
    expect(config.githubApp).toEqual({
      appId: '123',
      installationId: '456',
      privateKeyPem: privateKeyPem.trim(),
    });
    expect(resolveGitHubAuth(config)).toBe('app');
  });

  it('reads a private key file and normalizes Windows newlines', () => {
    const { privateKeyPem } = generateTestAppKey();
    const dir = mkdtempSync(path.join(tmpdir(), 'devops-mcp-'));
    const file = path.join(dir, 'app.pem');
    writeFileSync(file, privateKeyPem.replaceAll('\n', '\r\n'));
    try {
      const config = loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY_PATH: file,
      });
      expect(config.githubApp?.privateKeyPem).toBe(privateKeyPem.trim());
      expect(resolveGitHubAuth(config)).toBe('app');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails startup when the App configuration is incomplete and does not fall back', () => {
    const secret = 'ghp_should_not_be_used_abcdefghij';
    expect(() =>
      loadConfig({
        GITHUB_TOKEN: secret,
        GITHUB_APP_ID: '123',
      }),
    ).toThrow(/will not fall back to GITHUB_TOKEN/);
    try {
      loadConfig({ GITHUB_TOKEN: secret, GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/nope.pem' });
      expect.fail('expected incomplete App config to throw');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toContain('GITHUB_APP_ID');
      expect(message).toContain('GITHUB_APP_INSTALLATION_ID');
      expect(message).toContain('will not fall back to GITHUB_TOKEN');
      expect(message).not.toContain(secret);
    }
  });

  it('rejects both private key forms, a bad id, a directory, and a key that is not RSA', () => {
    const { privateKeyPem } = generateTestAppKey();
    expect(() =>
      loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        GITHUB_APP_PRIVATE_KEY_PATH: '/this/does/not/exist.pem',
      }),
    ).toThrow(/not both/);

    const pasted = '123SECRETKEYMATERIAL999';
    try {
      loadConfig({
        GITHUB_APP_ID: pasted,
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      });
      expect.fail('expected a bad app id to throw');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/GITHUB_APP_ID must be a positive integer/);
      expect(message).not.toContain('SECRETKEYMATERIAL');
      expect(message).not.toContain(privateKeyPem);
    }

    expect(() =>
      loadConfig({
        GITHUB_APP_ID: '10',
        GITHUB_APP_INSTALLATION_ID: '0',
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      }),
    ).toThrow(/GITHUB_APP_INSTALLATION_ID must be a positive integer/);

    expect(() =>
      loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY_PATH: tmpdir(),
      }),
    ).toThrow(/not a file/);

    const { privateKey: ecKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const ecLine = ecKey.split('\n').find((line) => line.length > 20 && !line.includes('-----'));
    try {
      loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY: ecKey,
      });
      expect.fail('expected a non-RSA key to throw');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/RSA/);
      if (ecLine) expect(message).not.toContain(ecLine);
    }
  });

  it('does not echo key material when the PEM cannot be parsed or the path looks like a key', () => {
    const secret = 'NOT_A_KEY_JUST_SECRET_MATERIAL_ABCDEFGH';
    try {
      loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----\n`,
      });
      expect.fail('expected an unparseable key to throw');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/could not be parsed/);
      expect(message).not.toContain(secret);
    }

    const leaked = 'LINE_OF_KEY_MATERIAL_THAT_MUST_NOT_LEAK';
    try {
      loadConfig({
        GITHUB_APP_ID: '12',
        GITHUB_APP_INSTALLATION_ID: '34',
        GITHUB_APP_PRIVATE_KEY_PATH: `-----BEGIN RSA PRIVATE KEY-----\n${leaked}\n-----END RSA PRIVATE KEY-----`,
      });
      expect.fail('expected a missing key path to throw');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      expect(message).toMatch(/Could not read/);
      expect(message).not.toContain(leaked);
    }
  });
});
