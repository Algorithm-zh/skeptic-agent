import { describe, expect, it } from 'vitest';
import { parseTestSummary } from '../../src/exec/test-summary';

describe('parseTestSummary', () => {
  it('parses node:test taps counts', () => {
    const summary = parseTestSummary(`
✔ applies a discount (0.5ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1
ℹ skipped 0
`);
    expect(summary.detected).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.zeroTests).toBe(false);
    expect(summary.allSkipped).toBe(false);
  });

  it('flags a fully skipped suite', () => {
    const summary = parseTestSummary(`
﹣ applies a discount (skipped)
ℹ tests 1
ℹ pass 0
ℹ fail 0
ℹ skipped 1
`);
    expect(summary.detected).toBe(true);
    expect(summary.total).toBe(1);
    expect(summary.allSkipped).toBe(true);
  });

  it('parses jest summaries', () => {
    const summary = parseTestSummary(`
FAIL tests/price.test.js
Tests:       1 failed, 1 passed, 2 total
`);
    expect(summary.detected).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('parses vitest summaries', () => {
    const summary = parseTestSummary(`
 Test Files  1 passed (1)
      Tests  2 passed (2)
`);
    expect(summary.detected).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('parses pytest summaries', () => {
    const summary = parseTestSummary('1 failed, 2 passed, 1 skipped in 0.12s');
    expect(summary.detected).toBe(true);
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('flags zero-test output', () => {
    const summary = parseTestSummary('No tests found in this project.');
    expect(summary.detected).toBe(true);
    expect(summary.zeroTests).toBe(true);
    expect(summary.total).toBe(0);
  });

  it('ignores output without test signals', () => {
    const summary = parseTestSummary('built 12 modules in 400ms');
    expect(summary.detected).toBe(false);
    expect(summary.zeroTests).toBe(false);
    expect(summary.allSkipped).toBe(false);
  });
});
