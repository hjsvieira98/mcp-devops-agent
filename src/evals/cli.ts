#!/usr/bin/env node
import { scenarios } from './scenarios.js';
import { formatReport, runScenarios } from './run.js';

const reports = await runScenarios(scenarios);
process.stdout.write(`${formatReport(reports)}\n`);
if (reports.some((report) => !report.passed)) process.exitCode = 1;
