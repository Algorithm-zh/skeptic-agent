import { describe, expect, it } from 'vitest';
import { computeVerdict, exitCodeForVerdict } from '../../src/verify/verdict';
import type { Claim, CheckResult, ReproductionResult } from '../../src/types';
import { makeCheck, makeFinding, makeRun } from '../helpers';

function verdictInput(overrides: {
  checks?: CheckResult[];
  reproductions?: ReproductionResult[];
  findings?: ReturnType<typeof makeFinding>[];
  claims?: Claim[];
} = {}) {
  return computeVerdict({
    checks: overrides.checks ?? [makeCheck()],
    reproductions: overrides.reproductions ?? [],
    findings: overrides.findings ?? [],
    claims: overrides.claims ?? [],
  });
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    text: 'All tests pass.',
    type: 'tests_pass',
    source: 'heuristic',
    status: 'unsupported',
    material: true,
    evidence: [],
    ...overrides,
  };
}

function reproduction(
  status: ReproductionResult['status'],
  overrides: Partial<ReproductionResult> = {},
): ReproductionResult {
  return {
    id: 'issue-1',
    name: 'Issue #1',
    command: 'node --test tests/price.test.js',
    status,
    ...overrides,
  };
}

describe('computeVerdict', () => {
  it('verifies a clean run', () => {
    const verdict = verdictInput();
    expect(verdict.level).toBe('verified');
    expect(verdict.reasons[0]).toContain('All required checks passed');
  });

  it('keeps soft findings at verified_with_warnings', () => {
    const verdict = verdictInput({ findings: [makeFinding('lockfile_drift', 'soft')] });
    expect(verdict.level).toBe('verified_with_warnings');
    expect(verdict.reasons[0]).toContain('lockfile_drift');
  });

  it('caps hard findings at unverified', () => {
    const verdict = verdictInput({ findings: [makeFinding('test_file_deleted', 'hard')] });
    expect(verdict.level).toBe('unverified');
  });

  it('fails on an attributable regression', () => {
    const verdict = verdictInput({
      checks: [
        makeCheck({
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          base: makeRun('passed', { detected: true, total: 1, passed: 1 }),
          attribution: 'regression',
        }),
      ],
    });
    expect(verdict.level).toBe('failed');
    expect(verdict.reasons[0]).toContain('passed at base');
  });

  it('does not blame a pre-existing failure on the change', () => {
    const verdict = verdictInput({
      checks: [
        makeCheck({
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          base: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          attribution: 'pre_existing_failure',
        }),
      ],
    });
    expect(verdict.level).toBe('unverified');
    expect(verdict.reasons[0]).toContain('pre-existing');
  });

  it('returns unverified when a required check could not complete', () => {
    const verdict = verdictInput({
      checks: [makeCheck({ head: makeRun('error', {}, { timedOut: true }) })],
    });
    expect(verdict.level).toBe('unverified');
    expect(verdict.reasons[0]).toContain('timed out');
  });

  it('ignores optional check failures', () => {
    const verdict = verdictInput({
      checks: [
        makeCheck(),
        makeCheck({ id: 'lint', required: false, head: makeRun('failed') }),
      ],
    });
    expect(verdict.level).toBe('verified');
  });

  it('caps a tainted reproduction at unverified', () => {
    const verdict = verdictInput({
      reproductions: [reproduction('tainted', { taint: 'Tests were modified.' })],
    });
    expect(verdict.level).toBe('unverified');
    expect(verdict.reasons[0]).toContain('tainted');
  });

  it('fails when the reproduction still fails at head', () => {
    const verdict = verdictInput({
      reproductions: [
        reproduction('not_proven', {
          base: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
        }),
      ],
    });
    expect(verdict.level).toBe('failed');
  });

  it('returns unverified for an inconclusive reproduction', () => {
    const verdict = verdictInput({
      reproductions: [
        reproduction('not_proven', {
          base: makeRun('passed', { detected: true, total: 1, passed: 1 }),
          head: makeRun('passed', { detected: true, total: 1, passed: 1 }),
        }),
      ],
    });
    expect(verdict.level).toBe('unverified');
  });

  it('returns unverified when a material claim lacks evidence', () => {
    const verdict = verdictInput({ claims: [claim()] });
    expect(verdict.level).toBe('unverified');
    expect(verdict.reasons[0]).toContain('Claim lacks evidence');
  });

  it('fails when a claim is contradicted by evidence', () => {
    const verdict = verdictInput({ claims: [claim({ status: 'contradicted' })] });
    expect(verdict.level).toBe('failed');
  });

  it('ignores unsupported LLM claims', () => {
    const verdict = verdictInput({
      claims: [claim({ source: 'llm', status: 'unsupported' })],
    });
    expect(verdict.level).toBe('verified');
  });

  it('caps at unverified before considering claims when a hard finding exists', () => {
    const verdict = verdictInput({
      findings: [makeFinding('test_file_deleted', 'hard')],
      claims: [claim({ status: 'contradicted' })],
    });
    expect(verdict.level).toBe('unverified');
  });
});

describe('exitCodeForVerdict', () => {
  it('maps verdicts to default exit codes', () => {
    expect(exitCodeForVerdict('verified', 'unverified')).toBe(0);
    expect(exitCodeForVerdict('verified_with_warnings', 'unverified')).toBe(0);
    expect(exitCodeForVerdict('unverified', 'unverified')).toBe(1);
    expect(exitCodeForVerdict('failed', 'unverified')).toBe(1);
  });

  it('honors the warnings threshold', () => {
    expect(exitCodeForVerdict('verified_with_warnings', 'warnings')).toBe(1);
    expect(exitCodeForVerdict('verified', 'warnings')).toBe(0);
  });

  it('honors never', () => {
    expect(exitCodeForVerdict('failed', 'never')).toBe(0);
    expect(exitCodeForVerdict('unverified', 'never')).toBe(0);
  });
});
