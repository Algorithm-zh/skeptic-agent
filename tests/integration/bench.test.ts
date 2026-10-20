import { describe, expect, it } from 'vitest';
import { formatFailure, runScenario } from '../../bench/harness';
import { BENCH_SCENARIOS } from '../../bench/scenarios';

describe('labeled fixture matrix', () => {
  for (const scenario of BENCH_SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const run = await runScenario(scenario);
      try {
        expect(run.failures.map(formatFailure)).toEqual([]);
        expect(run.receipt.verdict.level).toBe(scenario.expected);
      } finally {
        await run.cleanup();
      }
    });
  }
});
