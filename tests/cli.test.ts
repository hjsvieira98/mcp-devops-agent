import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/agent/cli.js';

describe('parseCliArgs', () => {
  it('joins the task and applies guardrail flags', () => {
    expect(parseCliArgs(['--max-steps', '4', '--yes', 'standup', 'please'])).toEqual({
      help: false,
      yes: true,
      maxSteps: 4,
      task: 'standup please',
      serverEntry: null,
    });
  });

  it('rejects an out-of-range step budget', () => {
    expect(() => parseCliArgs(['--max-steps', '0', 'hello'])).toThrow(/max-steps/);
  });
});
