import { describe, expect, it } from 'vitest';

import { loadConfig, parseRepositorySlug } from '../src/config.js';

describe('loadConfig', () => {
  it('parses a watchlist and ignores a blank token', () => {
    const config = loadConfig({
      GITHUB_TOKEN: '   ',
      GITHUB_REPOS: 'acme/web, other/api ',
    });
    expect(config.githubToken).toBeNull();
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
});
