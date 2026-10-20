import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyRepo } from '../../src/verify/orchestrator';

const CONFIG = `version: 1

checks:
  - id: overlay
    name: Overlay integrity
    run: node check.mjs
    required: true
    timeoutSec: 60
`;

const CHECK_SCRIPT = `import { existsSync, readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(readFileSync('src/app.js', 'utf8').includes('return 2;'), 'modified file did not reach the snapshot');
assert(existsSync('docs/中文 文件名.txt'), 'untracked unicode file missing');
assert(readFileSync('docs/中文 文件名.txt', 'utf8').trim() === 'hello 中文', 'unicode content mismatch');
assert(!existsSync('old-name.txt'), 'renamed source still present');
assert(readFileSync('new-name.txt', 'utf8').trim() === 'renamed', 'renamed target missing');
assert(!existsSync('obsolete.txt'), 'deleted file still present');
assert(readFileSync('assets/logo.bin')[0] === 0x42, 'binary modification missing');
assert(!existsSync('.env.local'), 'ignored file leaked into the snapshot');

console.log('# tests 1');
console.log('# pass 1');
console.log('ok 1 - overlay integrity');
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

async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = path.join(root, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

describe('dirty working-tree overlay', () => {
  it('copies modifications, deletions, renames, unicode paths, and binary files without touching the repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-overlay-'));
    const repoRoot = path.join(root, 'repo');
    try {
      await writeFiles(repoRoot, {
        'package.json': JSON.stringify({ name: 'overlay-fixture', private: true, type: 'module' }, null, 2),
        'skeptic.yml': CONFIG,
        'check.mjs': CHECK_SCRIPT,
        'src/app.js': 'export function value() {\n  return 1;\n}\n',
        'old-name.txt': 'renamed\n',
        'obsolete.txt': 'delete me\n',
        'assets/logo.bin': Buffer.from([0x41, 0x00, 0x01]),
        '.gitignore': '.skeptic/\n.env.local\n',
        'README.md': '# Overlay fixture\n',
      });

      await git(repoRoot, ['-c', 'init.defaultBranch=main', 'init', '-q']);
      await git(repoRoot, ['config', 'core.autocrlf', 'false']);
      await git(repoRoot, ['config', 'core.eol', 'lf']);
      await git(repoRoot, ['add', '-A']);
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
        'base',
      ]);

      await writeFile(path.join(repoRoot, 'src', 'app.js'), 'export function value() {\n  return 2;\n}\n');
      await rm(path.join(repoRoot, 'old-name.txt'));
      await writeFile(path.join(repoRoot, 'new-name.txt'), 'renamed\n');
      await rm(path.join(repoRoot, 'obsolete.txt'));
      await writeFile(path.join(repoRoot, 'assets', 'logo.bin'), Buffer.from([0x42, 0x00, 0x02]));
      await writeFiles(repoRoot, {
        'docs/中文 文件名.txt': 'hello 中文\n',
        '.env.local': 'IGNORED=1\n',
      });

      const statusBefore = await git(repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
      const treeBefore = (await git(repoRoot, ['write-tree'])).trim();
      const indexPath = path.isAbsolute((await git(repoRoot, ['rev-parse', '--git-path', 'index'])).trim())
        ? (await git(repoRoot, ['rev-parse', '--git-path', 'index'])).trim()
        : path.join(repoRoot, (await git(repoRoot, ['rev-parse', '--git-path', 'index'])).trim());
      const indexBefore = (await readFile(indexPath)).toString('base64');

      const outcome = await verifyRepo({ repoPath: repoRoot, llm: false });

      const statusAfter = await git(repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
      const treeAfter = (await git(repoRoot, ['write-tree'])).trim();
      const indexAfter = (await readFile(indexPath)).toString('base64');
      const worktreeList = await git(repoRoot, ['worktree', 'list', '--porcelain']);

      expect(statusAfter).toBe(statusBefore);
      expect(treeAfter).toBe(treeBefore);
      expect(indexAfter).toBe(indexBefore);
      expect(worktreeList.split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1);

      expect(outcome.receipt.checks[0]?.head?.status).toBe('passed');
      expect(outcome.receipt.verdict.level).toBe('verified');
      expect(outcome.receipt.forensics.findings).toEqual([]);
      expect(outcome.receipt.input.dirty).toBe(true);
      expect(outcome.receipt.input.changedFiles).toBe(6);
      expect(outcome.receipt.limitations.join('\n')).toContain('Ignored files are not copied');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
