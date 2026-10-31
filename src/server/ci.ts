import type { CheckRun, CombinedCommitStatus } from '../github/types.js';

export const CI_STATES = ['success', 'failure', 'pending', 'neutral', 'unknown'] as const;
export type CiState = (typeof CI_STATES)[number];

export type CiCheckView = {
  name: string;
  state: Exclude<CiState, 'unknown'>;
  url: string | null;
};

export type CiRollup = {
  state: CiState;
  checks: CiCheckView[];
};

/**
 * Failure wins over pending, which wins over success.
 * An empty set is `unknown` (no CI configured), not a passing build.
 */
export function rollupCi(status: CombinedCommitStatus, checks: readonly CheckRun[]): CiRollup {
  const views: CiCheckView[] = [...status.statuses.map(statusView), ...checks.map(checkView)];
  return { state: combine(views), checks: views };
}

function statusView(status: CombinedCommitStatus['statuses'][number]): CiCheckView {
  const state = status.state.toLowerCase();
  return {
    name: status.context,
    state:
      state === 'success'
        ? 'success'
        : state === 'failure' || state === 'error'
          ? 'failure'
          : 'pending',
    url: status.targetUrl,
  };
}

function checkView(check: CheckRun): CiCheckView {
  if (check.status.toLowerCase() !== 'completed') {
    return { name: check.name, state: 'pending', url: check.url };
  }
  const conclusion = (check.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return { name: check.name, state: 'success', url: check.url };
  if (conclusion === 'neutral' || conclusion === 'skipped' || conclusion === 'stale') {
    return { name: check.name, state: 'neutral', url: check.url };
  }
  if (
    conclusion === 'failure' ||
    conclusion === 'timed_out' ||
    conclusion === 'cancelled' ||
    conclusion === 'action_required' ||
    conclusion === 'startup_failure'
  ) {
    return { name: check.name, state: 'failure', url: check.url };
  }
  return { name: check.name, state: 'pending', url: check.url };
}

function combine(checks: readonly CiCheckView[]): CiState {
  if (checks.length === 0) return 'unknown';
  if (checks.some((check) => check.state === 'failure')) return 'failure';
  if (checks.some((check) => check.state === 'pending')) return 'pending';
  if (checks.every((check) => check.state === 'neutral')) return 'neutral';
  return 'success';
}
