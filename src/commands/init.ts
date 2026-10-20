import path from 'node:path';
import pc from 'picocolors';
import { SkepticError } from '../errors';
import { getRepoRoot } from '../git/git';
import { pathExists, readTextIfExists, writeText } from '../util/fs';

export interface InitOptions {
  repoPath: string;
  force?: boolean;
}

function buildConfig(hasTestScript: boolean, hasLockfile: boolean): string {
  const lines = ['version: 1', ''];
  lines.push('# Skeptic reads this file from the base revision.');
  lines.push('# Changes made to it at head are reported, never trusted.');
  if (hasLockfile) {
    lines.push('setup: npm ci --ignore-scripts');
  }
  lines.push('checks:');
  lines.push('  - id: unit');
  lines.push('    name: Unit tests');
  lines.push('    run: npm test');
  lines.push('    required: true');
  lines.push('    timeoutSec: 300');
  lines.push('');
  lines.push('# Add a reproduction to prove that a specific bug existed before the change');
  lines.push('# and is gone after it:');
  lines.push('# reproductions:');
  lines.push('#   - id: issue-42');
  lines.push('#     name: "Issue #42"');
  lines.push('#     run: npm test -- tests/price.test.ts');
  lines.push('#     expect: fail-before-pass-after');
  lines.push('');
  lines.push('allowScripts: false');
  lines.push('llm:');
  lines.push('  enabled: false');
  if (!hasTestScript) {
    lines.push('');
    lines.push('# No npm test script was detected. Replace the unit check command above');
    lines.push('# with the command that runs this project\'s test suite.');
  }
  return `${lines.join('\n')}\n`;
}

async function ensureGitignoreEntry(repoPath: string): Promise<void> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  const existing = (await readTextIfExists(gitignorePath)) ?? '';
  const lines = existing.split(/\r?\n/);
  if (lines.includes('.skeptic/') || lines.includes('.skeptic')) {
    return;
  }
  const suffix = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeText(gitignorePath, `${existing}${suffix}.skeptic/\n`);
}

export async function runInit(options: InitOptions): Promise<number> {
  const repoRoot = await getRepoRoot(options.repoPath);
  const configPath = path.join(repoRoot, 'skeptic.yml');
  if ((await pathExists(configPath)) && !options.force) {
    throw new SkepticError(
      'CONFIG_EXISTS',
      'skeptic.yml already exists.',
      'Review the existing config, or pass --force to overwrite it.',
    );
  }

  let hasTestScript = false;
  const packageText = await readTextIfExists(path.join(repoRoot, 'package.json'));
  if (packageText) {
    try {
      const manifest = JSON.parse(packageText) as { scripts?: Record<string, unknown> };
      hasTestScript = typeof manifest.scripts?.test === 'string';
    } catch {
      // A malformed package.json is reported by the checks themselves.
    }
  }
  const hasLockfile = await pathExists(path.join(repoRoot, 'package-lock.json'));

  await writeText(configPath, buildConfig(hasTestScript, hasLockfile));
  await ensureGitignoreEntry(repoRoot);

  process.stdout.write(`${pc.green('Created')} skeptic.yml\n`);
  process.stdout.write(`  ${pc.dim('check')}  npm test\n`);
  if (!hasTestScript) {
    process.stdout.write(
      `  ${pc.yellow('warning')}  No test script was detected in package.json. Edit the check before using it.\n`,
    );
  }
  process.stdout.write('\nNext:\n');
  process.stdout.write('  1. Review and commit skeptic.yml so it becomes the trusted contract.\n');
  process.stdout.write('  2. Run: skeptic verify --claims "All tests pass."\n');
  process.stdout.write(
    `${pc.dim('   (If you verify before committing, pass --trust-config explicitly.)')}\n`,
  );
  return 0;
}
