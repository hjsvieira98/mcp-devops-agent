import { describe, expect, it } from 'vitest';

import { scenarios } from '../src/evals/scenarios.js';
import { formatReport, runScenarios } from '../src/evals/run.js';

describe('agent eval scenarios', () => {
  it('runs every scripted scenario against the MCP server', async () => {
    const reports = await runScenarios(scenarios);
    expect(reports.length).toBeGreaterThanOrEqual(4);
    const failed = reports.filter((report) => !report.passed);
    expect(failed, formatReport(reports)).toEqual([]);
  });
});
