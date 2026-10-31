import { describe, expect, it } from 'vitest';

import { rollupCi } from '../src/server/ci.js';
import { truncate } from '../src/server/text.js';

describe('rollupCi', () => {
  it('treats an empty set as unknown', () => {
    expect(rollupCi({ statuses: [] }, []).state).toBe('unknown');
  });

  it('lets a failure win over a pending check', () => {
    const rollup = rollupCi(
      { statuses: [{ context: 'build', state: 'failure', targetUrl: null, description: null }] },
      [{ name: 'lint', status: 'in_progress', conclusion: null, url: null }],
    );
    expect(rollup.state).toBe('failure');
  });

  it('reports pending while a check is still running and nothing has failed', () => {
    const rollup = rollupCi({ statuses: [] }, [
      { name: 'unit', status: 'completed', conclusion: 'success', url: null },
      { name: 'e2e', status: 'queued', conclusion: null, url: null },
    ]);
    expect(rollup.state).toBe('pending');
  });

  it('reports success when every signal passed or was skipped', () => {
    const rollup = rollupCi(
      {
        statuses: [
          {
            context: 'build',
            state: 'success',
            targetUrl: 'https://ci.example',
            description: null,
          },
        ],
      },
      [{ name: 'optional', status: 'completed', conclusion: 'skipped', url: null }],
    );
    expect(rollup.state).toBe('success');
  });
});

describe('truncate', () => {
  it('marks text that does not fit and stays inside the budget', () => {
    const result = truncate('abcdefghijklmnopqrstuvwxyz', 20);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('[truncated]')).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(20);
  });
});
