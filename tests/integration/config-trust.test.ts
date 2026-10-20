import { execa } from 'execa';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyRepo } from '../../src/verify/orchestrator';

const CONFIG = `version: 1

checks:
  - id: unit
    name: Unit tests
    run: node --test
    required: true
    timeoutSec: 60
`;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    reject: false,
    encoding: 'utf8',
    stripFinalNewline: false,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = path.join(root, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

async function createRepo(root: string): Promise<void> {
  await writeFiles(root, {
    'package.json': JSON.stringify({ name: 'trust-fixture', private: true, type: 'module' }, null, 2),
    'src/price.js': 'export function applyDiscount(price) {\n  return price * 0.9;\n}\n',
    'tests/price.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
});
`,
    '.gitignore': '.skeptic/\n',
  });
  await git(root, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'core.eol', 'lf']);
  await git(root, ['add', '-A']);
  await git(root, [
    '-c',
    'user.name=Skeptic Test',
    '-c',
    'user.email=test@skeptic.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'base without verification config',
  ]);
}

describe('configuration trust', () => {
  it('refuses an uncommitted config unless the operator trusts it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-trust-'));
    const repoRoot = path.join(root, 'repo');
    try {
      await createRepo(repoRoot);
      await writeFile(path.join(repoRoot, 'skeptic.yml'), CONFIG, 'utf8');

      await expect(verifyRepo({ repoPath: repoRoot, llm: false })).rejects.toMatchObject({
        code: 'CONFIG_UNTRUSTED',
      });

      const outcome = await verifyRepo({
        repoPath: repoRoot,
        llm: false,
        trustConfig: true,
        claimsText: 'All tests pass.',
      });

      expect(outcome.receipt.config.source).toBe('trusted-worktree');
      expect(outcome.receipt.config.trusted).toBe(true);
      expect(outcome.receipt.config.modified).toBe(false);
      expect(outcome.receipt.verdict.level).toBe('verified_with_warnings');
      expect(outcome.receipt.forensics.findings.some((finding) => finding.rule === 'protected_file_modified')).toBe(true);
      expect(outcome.receipt.limitations.join('\n')).toContain('uncommitted file explicitly trusted');
      expect(outcome.receipt.claims.find((claim) => claim.type === 'tests_pass')?.status).toBe('supported');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers a base-ref config over the working-tree version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-trust-base-'));
    const repoRoot = path.join(root, 'repo');
    try {
      await createRepo(repoRoot);
      await writeFile(path.join(repoRoot, 'skeptic.yml'), CONFIG, 'utf8');
      await git(repoRoot, ['add', 'skeptic.yml']);
      await git(repoRoot, [
        '-c',
        'user.name=Skeptic Test',
        '-c',
        'user.email=test@skeptic.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'add trusted config',
      ]);

      await writeFile(
        path.join(repoRoot, 'skeptic.yml'),
        CONFIG.replace('run: node --test', 'run: node --test tests/nonexistent.test.js'),
        'utf8',
      );

      const outcome = await verifyRepo({ repoPath: repoRoot, llm: false });

      expect(outcome.receipt.config.source).toBe('base');
      expect(outcome.receipt.config.modified).toBe(true);
      expect(outcome.receipt.checks[0]?.command).toBe('node --test');
      expect(outcome.receipt.checks[0]?.head?.status).toBe('passed');
      expect(outcome.receipt.forensics.findings.some((finding) => finding.rule === 'check_command_modified')).toBe(true);
      expect(outcome.receipt.verdict.level).toBe('unverified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
