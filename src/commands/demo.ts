import { execa } from 'execa';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { verifyRepo } from '../verify/orchestrator';
import type { VerdictLevel } from '../types';

const BASE_SOURCE = `export function applyDiscount(price) {
  return price;
}
`;

const FIXED_SOURCE = `export function applyDiscount(price) {
  return price * 0.9;
}
`;

const HARDCODED_SOURCE = `export function applyDiscount(price) {
  if (price === 100) {
    return 90;
  }
  return price;
}
`;

const BASE_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
});
`;

const SKIPPED_TEST = BASE_TEST.replace(
  "test('applies a ten percent discount'",
  "test.skip('applies a ten percent discount'",
);

const WEAKENED_TEST = BASE_TEST.replace('applyDiscount(100), 90', 'applyDiscount(100), 100');

const CONFIG = `version: 1

checks:
  - id: unit
    name: Unit tests
    run: node --test
    required: true
    timeoutSec: 60

reproductions:
  - id: issue-1
    name: "Issue #1 - discount bug"
    run: node --test tests/price.test.js
    expect: fail-before-pass-after
`;

const PACKAGE_JSON = `{
  "name": "skeptic-demo-pricing",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

interface Scenario {
  id: string;
  title: string;
  expected: VerdictLevel;
  claims: string;
  files: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'legit-fix',
    title: 'The agent actually fixed the bug',
    expected: 'verified',
    claims: 'All tests pass. Fixes #1.',
    files: { 'src/price.js': FIXED_SOURCE },
  },
  {
    id: 'skipped-test',
    title: 'The agent skipped the failing test',
    expected: 'unverified',
    claims: 'All tests pass. Fixes #1.',
    files: { 'tests/price.test.js': SKIPPED_TEST },
  },
  {
    id: 'weakened-assertion',
    title: 'The agent changed the assertion to match the bug',
    expected: 'unverified',
    claims: 'All tests pass. Fixes #1.',
    files: { 'tests/price.test.js': WEAKENED_TEST },
  },
  {
    id: 'hardcoded-value',
    title: 'The agent hardcoded the tested value',
    expected: 'unverified',
    claims: 'All tests pass. Fixes #42.',
    files: { 'src/price.js': HARDCODED_SOURCE },
  },
];

export interface DemoOptions {
  keep?: boolean;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    windowsHide: true,
    reject: true,
  });
}

async function createScenarioRepo(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    PACKAGE_JSON,
    'utf8',
  );
  await writeFile(path.join(dir, 'src', 'price.js'), BASE_SOURCE, 'utf8');
  await writeFile(path.join(dir, 'tests', 'price.test.js'), BASE_TEST, 'utf8');
  await writeFile(path.join(dir, 'skeptic.yml'), CONFIG, 'utf8');
  await writeFile(
    path.join(dir, '.gitignore'),
    '.skeptic/\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'README.md'),
    '# Demo pricing package\n\nA tiny repository used by `skeptic demo`.\n',
    'utf8',
  );

  await git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await git(dir, ['config', 'core.eol', 'lf']);
  await git(dir, ['add', '-A']);
  await git(dir, [
    '-c',
    'user.name=Skeptic Demo',
    '-c',
    'user.email=demo@skeptic.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'base: discount logic and failing test',
  ]);
}

function verdictLabel(level: VerdictLevel): string {
  if (level === 'verified') return pc.green(pc.bold('VERIFIED'));
  if (level === 'verified_with_warnings') return pc.yellow(pc.bold('VERIFIED WITH WARNINGS'));
  if (level === 'unverified') return pc.yellow(pc.bold('UNVERIFIED'));
  return pc.red(pc.bold('FAILED'));
}

export async function runDemoCommand(options: DemoOptions): Promise<number> {
  const startedAt = Date.now();
  const demoRoot = await mkdtemp(path.join(os.tmpdir(), 'skeptic-demo-'));
  process.stdout.write(
    `\n${pc.bold('Skeptic demo')} ${pc.dim('- independent verification, no API key required')}\n\n`,
  );
  process.stdout.write(
    `${pc.dim('A tiny repo with a failing test. Four agents claim the same thing: "tests pass".')}\n\n`,
  );

  let matched = 0;
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      const dir = path.join(demoRoot, `${String(index + 1).padStart(2, '0')}-${scenario.id}`);
      await mkdir(dir, { recursive: true });
      await createScenarioRepo(dir);
      for (const [filePath, content] of Object.entries(scenario.files)) {
        await writeFile(path.join(dir, filePath), content, 'utf8');
      }

      const outcome = await verifyRepo({
        repoPath: dir,
        claimsText: scenario.claims,
        llm: false,
        failOn: 'never',
      });
      const actual = outcome.receipt.verdict.level;
      const ok = actual === scenario.expected;
      if (ok) matched += 1;

      process.stdout.write(
        `${pc.bold(`[${index + 1}/${SCENARIOS.length}]`)} ${scenario.title}\n`,
      );
      process.stdout.write(
        `      ${verdictLabel(actual)}  ${ok ? pc.green('as expected') : `${pc.red('expected')} ${verdictLabel(scenario.expected)}`}\n`,
      );
      for (const reason of outcome.receipt.verdict.reasons.slice(0, 2)) {
        process.stdout.write(`      ${pc.dim(`- ${reason}`)}\n`);
      }
      process.stdout.write('\n');
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `${matched === SCENARIOS.length ? pc.green(`${matched}/${SCENARIOS.length} verdicts matched expectations`) : pc.red(`${matched}/${SCENARIOS.length} verdicts matched expectations`)} ${pc.dim(`in ${elapsed}s`)}\n`,
    );
    if (options.keep) {
      process.stdout.write(`\nDemo repositories and receipts kept at:\n  ${demoRoot}\n`);
    } else {
      process.stdout.write(
        `\n${pc.dim('Each run wrote a receipt and Markdown report inside its isolated repository.')}\n`,
      );
    }
    process.stdout.write(
      `\nTry it in a real repository:\n  ${pc.bold('skeptic init')}\n  ${pc.bold('skeptic verify --claims "All tests pass. Fixes #42."')}\n\n`,
    );

    return matched === SCENARIOS.length ? 0 : 1;
  } finally {
    if (!options.keep) {
      await rm(demoRoot, { recursive: true, force: true });
    }
  }
}
