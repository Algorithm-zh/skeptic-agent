import { stripAnsi } from '../util/ansi';
import type { TestSummary } from '../types';

function emptySummary(detected = false): TestSummary {
  return {
    detected,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    zeroTests: detected,
    allSkipped: false,
  };
}

function parseCounts(line: string): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const match of line.matchAll(/(\d+)\s+(failed|passed|skipped)/gi)) {
    const count = Number(match[1]);
    const kind = match[2]?.toLowerCase();
    if (kind === 'failed') failed += count;
    if (kind === 'passed') passed += count;
    if (kind === 'skipped') skipped += count;
  }
  return { passed, failed, skipped };
}

export function parseTestSummary(rawOutput: string): TestSummary {
  const output = stripAnsi(rawOutput);
  const lines = output.split(/\r?\n/);
  const summary = emptySummary(false);

  let nodeTests: number | undefined;
  let nodePass = 0;
  let nodeFail = 0;
  let nodeSkip = 0;

  for (const line of lines) {
    const nodeMatch = line.match(/^(?:#|[iℹ])\s*(pass|fail|skipped|tests|cancelled|todo)\s+(\d+)\s*$/i);
    if (nodeMatch) {
      const kind = nodeMatch[1]?.toLowerCase();
      const count = Number(nodeMatch[2]);
      summary.detected = true;
      if (kind === 'pass') nodePass += count;
      if (kind === 'fail') nodeFail += count;
      if (kind === 'skipped') nodeSkip += count;
      if (kind === 'tests') nodeTests = count;
    }

    if (/^Tests:\s/.test(line) || /^Tests\s{2,}/.test(line)) {
      const counts = parseCounts(line);
      const totalMatch = line.match(/(\d+)\s+total/i) ?? line.match(/\((\d+)\)/);
      const total = totalMatch ? Number(totalMatch[1]) : counts.passed + counts.failed + counts.skipped;
      summary.detected = true;
      summary.passed = Math.max(summary.passed, counts.passed);
      summary.failed = Math.max(summary.failed, counts.failed);
      summary.skipped = Math.max(summary.skipped, counts.skipped);
      summary.total = Math.max(summary.total, total);
    }
  }

  if (nodeTests !== undefined || nodePass + nodeFail + nodeSkip > 0) {
    summary.detected = true;
    summary.passed = nodePass;
    summary.failed = nodeFail;
    summary.skipped = nodeSkip;
    summary.total = nodeTests ?? nodePass + nodeFail + nodeSkip;
  }

  const pytestCounts = lines
    .filter((line) => /\b\d+\s+(passed|failed|skipped|error)/i.test(line))
    .at(-1);
  if (pytestCounts) {
    const counts = parseCounts(pytestCounts);
    const errors = Number(pytestCounts.match(/(\d+)\s+error/i)?.[1] ?? 0);
    summary.detected = true;
    summary.passed = Math.max(summary.passed, counts.passed);
    summary.failed = Math.max(summary.failed, counts.failed + errors);
    summary.skipped = Math.max(summary.skipped, counts.skipped);
    summary.total = Math.max(summary.total, counts.passed + counts.failed + errors + counts.skipped);
  }

  const zeroPattern = /no tests found|no tests ran|collected 0 items|--- no tests|0 tests? matched/i;
  if (zeroPattern.test(output)) {
    summary.detected = true;
    summary.total = 0;
    summary.passed = 0;
    summary.failed = 0;
    summary.skipped = 0;
  }

  if (summary.detected && summary.total === 0 && summary.passed + summary.failed + summary.skipped === 0) {
    summary.zeroTests = true;
  } else {
    summary.zeroTests = summary.detected && summary.total === 0;
  }

  summary.allSkipped =
    summary.detected &&
    summary.skipped > 0 &&
    summary.passed === 0 &&
    summary.failed === 0;

  return summary;
}
