import pc from 'picocolors';
import { runScenario } from './harness';
import { BENCH_SCENARIOS } from './scenarios';
import type { VerdictLevel } from '../src/types';

function verdictLabel(level: VerdictLevel): string {
  if (level === 'verified') return pc.green(level);
  if (level === 'verified_with_warnings') return pc.yellow(level);
  if (level === 'unverified') return pc.yellow(level);
  return pc.red(level);
}

async function main(): Promise<number> {
  const filter = process.argv[2]?.toLowerCase();
  const scenarios = filter
    ? BENCH_SCENARIOS.filter(
        (scenario) =>
          scenario.id.includes(filter) ||
          scenario.category === filter ||
          scenario.expected === filter,
      )
    : BENCH_SCENARIOS;

  if (scenarios.length === 0) {
    process.stderr.write(`No bench scenarios matched "${filter}".\n`);
    return 1;
  }

  process.stdout.write(
    `\n${pc.bold('Skeptic fixture matrix')} ${pc.dim(`- ${scenarios.length} labeled scenario(s)`)}\n\n`,
  );

  let passed = 0;
  const startedAt = Date.now();
  for (const [index, scenario] of scenarios.entries()) {
    process.stdout.write(
      `${pc.dim(`[${index + 1}/${scenarios.length}]`)} ${pc.bold(scenario.id)} ${pc.dim(`(${scenario.category})`)}\n`,
    );
    const run = await runScenario(scenario);
    try {
      const ok = run.failures.length === 0;
      if (ok) passed += 1;
      process.stdout.write(
        `      ${verdictLabel(run.receipt.verdict.level)} ${pc.dim(`(${run.receipt.forensics.hardCount} hard, ${run.receipt.forensics.softCount} soft)`)} ${ok ? pc.green('pass') : pc.red('FAIL')}\n`,
      );
      if (!ok) {
        for (const failure of run.failures) {
          process.stdout.write(`      ${pc.red('x')} ${failure.name}${failure.detail ? pc.dim(` - ${failure.detail}`) : ''}\n`);
        }
      }
    } finally {
      await run.cleanup();
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = `${passed}/${scenarios.length} scenarios passed`;
  process.stdout.write(
    `\n${passed === scenarios.length ? pc.green(summary) : pc.red(summary)} ${pc.dim(`in ${elapsed}s`)}\n\n`,
  );
  return passed === scenarios.length ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Bench run failed: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
