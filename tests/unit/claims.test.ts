import { describe, expect, it } from 'vitest';
import { evaluateClaims, extractHeuristicClaims } from '../../src/verify/claims';
import type { Claim, CheckResult, ReproductionResult } from '../../src/types';
import { makeCheck, makeFinding, makeRun } from '../helpers';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    text: 'All tests pass.',
    type: 'tests_pass',
    source: 'heuristic',
    status: 'informational',
    material: true,
    evidence: [],
    ...overrides,
  };
}

function evaluate(claim: Claim, context: {
  checks?: CheckResult[];
  reproductions?: ReproductionResult[];
  findings?: ReturnType<typeof makeFinding>[];
}): Claim {
  return evaluateClaims([claim], {
    checks: context.checks ?? [],
    reproductions: context.reproductions ?? [],
    findings: context.findings ?? [],
  })[0] as Claim;
}

function reproduction(status: ReproductionResult['status'], overrides: Partial<ReproductionResult> = {}): ReproductionResult {
  return {
    id: 'issue-1',
    name: 'Issue #1',
    command: 'node --test tests/price.test.js',
    status,
    ...overrides,
  };
}

describe('extractHeuristicClaims', () => {
  it('extracts a tests-pass claim and an issue reference', () => {
    const claims = extractHeuristicClaims('All tests pass. Fixes #42.');
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'tests_pass', material: true });
    expect(claims[1]).toMatchObject({ type: 'bug_fixed', issue: 42, material: true });
  });

  it('recognizes common green-suite phrasing', () => {
    expect(extractHeuristicClaims('The suite is green.').some((claim) => claim.type === 'tests_pass')).toBe(true);
    expect(extractHeuristicClaims('Tests are green.').some((claim) => claim.type === 'tests_pass')).toBe(true);
    expect(extractHeuristicClaims('All checks pass.').some((claim) => claim.type === 'tests_pass')).toBe(true);
  });

  it('recognizes closes and resolves references', () => {
    expect(extractHeuristicClaims('Closes #7.').find((claim) => claim.type === 'bug_fixed')?.issue).toBe(7);
    expect(extractHeuristicClaims('Resolves issue #9.').find((claim) => claim.type === 'bug_fixed')?.issue).toBe(9);
  });

  it('ignores text without claims', () => {
    expect(extractHeuristicClaims('Refactored the parser and updated docs.')).toEqual([]);
  });

  it('caps the number of processed sentences', () => {
    const text = Array.from({ length: 40 }, () => 'All tests pass.').join('\n');
    expect(extractHeuristicClaims(text).length).toBeLessThanOrEqual(1);
  });

  it('handles empty input', () => {
    expect(extractHeuristicClaims(undefined)).toEqual([]);
    expect(extractHeuristicClaims('   ')).toEqual([]);
  });
});

describe('evaluateClaims: tests_pass', () => {
  it('supports the claim when a required check passed with executed tests', () => {
    const result = evaluate(makeClaim(), {
      checks: [
        makeCheck({
          head: makeRun('passed', { detected: true, total: 2, passed: 2 }),
        }),
      ],
    });
    expect(result.status).toBe('supported');
    expect(result.evidence[0]).toContain('check:unit');
  });

  it('rejects a green run with zero executed tests', () => {
    const result = evaluate(makeClaim(), {
      checks: [
        makeCheck({
          head: makeRun('passed', { detected: true, total: 0, zeroTests: true }),
        }),
      ],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('zero executed tests');
  });

  it('rejects a passed check with no test output', () => {
    const result = evaluate(makeClaim(), {
      checks: [makeCheck({ head: makeRun('passed', { detected: false }) })],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('no executed test results');
  });

  it('contradicts the claim on a regression', () => {
    const result = evaluate(makeClaim(), {
      checks: [
        makeCheck({
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          attribution: 'regression',
        }),
      ],
    });
    expect(result.status).toBe('contradicted');
  });

  it('does not call a pre-existing failure a contradiction', () => {
    const result = evaluate(makeClaim(), {
      checks: [
        makeCheck({
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          attribution: 'pre_existing_failure',
        }),
      ],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('pre-existing');
  });

  it('rejects claims undermined by hard integrity findings', () => {
    const result = evaluate(makeClaim(), {
      checks: [
        makeCheck({
          head: makeRun('passed', { detected: true, total: 1, passed: 1 }),
        }),
      ],
      findings: [makeFinding('test_file_deleted')],
    });
    expect(result.status).toBe('unsupported');
    expect(result.evidence).toContain('forensics:test_file_deleted');
  });

  it('rejects a missing check id', () => {
    const result = evaluate(makeClaim({ checkId: 'missing' }), {
      checks: [makeCheck()],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('does not exist');
  });

  it('rejects claims when no checks exist', () => {
    const result = evaluate(makeClaim(), { checks: [] });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('No verification check');
  });
});

describe('evaluateClaims: bug_fixed', () => {
  const bugClaim = makeClaim({ text: 'Fixes #1.', type: 'bug_fixed', issue: 1 });

  it('supports the claim when the reproduction is proven', () => {
    const result = evaluate(bugClaim, {
      reproductions: [reproduction('proven')],
    });
    expect(result.status).toBe('supported');
    expect(result.evidence).toContain('reproduction:issue-1 (proven)');
  });

  it('rejects the claim without a matching reproduction', () => {
    const result = evaluate(bugClaim, { reproductions: [] });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('No configured reproduction covers issue #1');
  });

  it('rejects a matching reproduction with a different issue number', () => {
    const result = evaluate(makeClaim({ type: 'bug_fixed', issue: 2 }), {
      reproductions: [reproduction('proven')],
    });
    expect(result.status).toBe('unsupported');
  });

  it('rejects a tainted reproduction', () => {
    const result = evaluate(bugClaim, {
      reproductions: [
        reproduction('tainted', { taint: 'The reproduction depends on modified tests.' }),
      ],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('modified tests');
  });

  it('contradicts the claim when the reproduction still fails at head', () => {
    const result = evaluate(bugClaim, {
      reproductions: [
        reproduction('not_proven', {
          base: makeRun('failed', { detected: true, total: 1, failed: 1 }),
          head: makeRun('failed', { detected: true, total: 1, failed: 1 }),
        }),
      ],
    });
    expect(result.status).toBe('contradicted');
  });

  it('rejects a reproduction that also passed at base', () => {
    const result = evaluate(bugClaim, {
      reproductions: [
        reproduction('not_proven', {
          base: makeRun('passed', { detected: true, total: 1, passed: 1 }),
          head: makeRun('passed', { detected: true, total: 1, passed: 1 }),
        }),
      ],
    });
    expect(result.status).toBe('unsupported');
    expect(result.rationale).toContain('did not fail before the change');
  });
});
