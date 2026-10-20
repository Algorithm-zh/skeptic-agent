import type {
  CheckResult,
  Finding,
  Inventory,
  RunResult,
  TestSummary,
} from '../src/types';

export function makeRun(
  status: RunResult['status'] = 'passed',
  summary: Partial<TestSummary> = {},
  overrides: Partial<RunResult> = {},
): RunResult {
  return {
    status,
    exitCode: status === 'passed' ? 0 : 1,
    durationMs: 1,
    timedOut: false,
    logFile: '',
    logSha256: '',
    outputExcerpt: '',
    summary: {
      detected: false,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      zeroTests: false,
      allSkipped: false,
      ...summary,
    },
    ...overrides,
  };
}

export function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'unit',
    name: 'Unit tests',
    required: true,
    command: 'node --test',
    head: makeRun(),
    ...overrides,
  };
}

export function makeInventory(
  fileTests: Record<string, { tests: number; assertions: number }> = {},
): Inventory {
  const entries = Object.entries(fileTests);
  return {
    testFiles: entries.length,
    testCount: entries.reduce((total, [, stats]) => total + stats.tests, 0),
    assertionCount: entries.reduce((total, [, stats]) => total + stats.assertions, 0),
    files: entries.map(([filePath]) => filePath).sort(),
    fileTests,
    partial: false,
  };
}

export function makeFinding(
  rule: string,
  severity: Finding['severity'] = 'hard',
  overrides: Partial<Finding> = {},
): Finding {
  return {
    rule,
    severity,
    title: rule,
    message: `${rule} finding`,
    ...overrides,
  };
}
