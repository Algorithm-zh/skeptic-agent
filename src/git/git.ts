import { execa } from 'execa';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SkepticError } from '../errors';
import { copyPathPreservingMode, pathExists, removePath, safeJoin } from '../util/fs';
import type { ChangeStatus } from '../types';

export interface FileSnapshot {
  buffer: Buffer;
  text: string;
  isBinary: boolean;
}

export interface RawChange {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
}

interface GitTextResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
}

async function gitText(cwd: string, args: string[]): Promise<GitTextResult> {
  try {
    const result = await execa('git', ['-c', 'core.longpaths=true', ...args], {
      cwd,
      reject: false,
      encoding: 'utf8',
      stripFinalNewline: false,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 1,
      failed: result.failed ?? false,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: (error as Error).message,
      exitCode: 1,
      failed: true,
    };
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  return Buffer.alloc(0);
}

async function gitBuffer(cwd: string, args: string[]) {
  try {
    const result = await execa('git', ['-c', 'core.longpaths=true', ...args], {
      cwd,
      reject: false,
      encoding: 'buffer',
      stripFinalNewline: false,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: toBuffer(result.stdout),
      stderr: toBuffer(result.stderr),
      exitCode: result.exitCode ?? 1,
      failed: result.failed ?? false,
    };
  } catch {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 1,
      failed: true,
    };
  }
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await gitText(cwd, args);
  if (result.exitCode !== 0) {
    throw new SkepticError(
      'GIT_COMMAND_FAILED',
      `git ${args.join(' ')} failed: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout;
}

export async function getRepoRoot(inputPath: string): Promise<string> {
  const result = await gitText(inputPath, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) {
    throw new SkepticError(
      'NOT_A_GIT_REPOSITORY',
      `Not a git repository: ${inputPath}`,
      'Skeptic verifies git changes. Run inside a git repository, or use the built-in demo.',
    );
  }
  return result.stdout.trim();
}

export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  const result = await gitText(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.exitCode !== 0) {
    throw new SkepticError(
      'INVALID_REF',
      `Could not resolve git ref: ${ref}`,
      'Provide a commit, branch, or tag that exists in this repository.',
    );
  }
  return result.stdout.trim();
}

export async function getWorkingStatus(repoPath: string): Promise<string> {
  const result = await gitText(repoPath, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]);
  return result.stdout;
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  return (await getWorkingStatus(repoPath)).length === 0;
}

export async function readFileAtRef(
  repoPath: string,
  ref: string,
  filePath: string,
): Promise<FileSnapshot | undefined> {
  const result = await gitBuffer(repoPath, ['show', `${ref}:${filePath}`]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const buffer = result.stdout;
  const isBinary = buffer.subarray(0, 8192).includes(0);
  return {
    buffer,
    text: buffer.toString('utf8'),
    isBinary,
  };
}

export async function readWorkingFile(
  repoPath: string,
  filePath: string,
): Promise<FileSnapshot | undefined> {
  try {
    const buffer = await readFile(safeJoin(repoPath, filePath));
    const isBinary = buffer.subarray(0, 8192).includes(0);
    return {
      buffer,
      text: buffer.toString('utf8'),
      isBinary,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseNameStatus(output: string): RawChange[] {
  const tokens = output.split('\0');
  const changes: RawChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) {
      continue;
    }
    const letter = token[0] as ChangeStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath && newPath) {
        changes.push({ status: letter, oldPath, path: newPath });
      }
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (filePath) {
      changes.push({ status: letter, path: filePath });
    }
  }
  return changes;
}

export async function listChangesRaw(
  repoPath: string,
  baseRef: string,
  headRef?: string,
): Promise<RawChange[]> {
  const args = ['diff', '--name-status', '-z', '-M', '--no-ext-diff', baseRef];
  if (headRef) {
    args.push(headRef);
  }
  const result = await gitText(repoPath, args);
  if (result.exitCode !== 0) {
    throw new SkepticError('GIT_DIFF_FAILED', `Could not diff ${baseRef}: ${result.stderr.trim()}`);
  }
  const changes = parseNameStatus(result.stdout);
  if (!headRef) {
    const untracked = await gitText(repoPath, [
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    ]);
    if (untracked.exitCode !== 0) {
      throw new SkepticError('GIT_DIFF_FAILED', 'Could not list untracked files.');
    }
    for (const filePath of untracked.stdout.split('\0')) {
      if (filePath) {
        changes.push({ status: 'A', path: filePath });
      }
    }
  }
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.status}:${change.oldPath ?? ''}:${change.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function listDirtyChanges(repoPath: string): Promise<RawChange[]> {
  return listChangesRaw(repoPath, 'HEAD');
}

export async function listWorktreeFiles(rootPath: string): Promise<string[]> {
  const tracked = await gitText(rootPath, ['ls-files', '-z']);
  const untracked = await gitText(rootPath, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (tracked.exitCode !== 0) {
    throw new SkepticError('GIT_LS_FAILED', `Could not list files in ${rootPath}`);
  }
  const files = new Set<string>();
  for (const filePath of tracked.stdout.split('\0')) {
    if (filePath) files.add(filePath);
  }
  if (untracked.exitCode === 0) {
    for (const filePath of untracked.stdout.split('\0')) {
      if (filePath) files.add(filePath);
    }
  }
  return [...files].sort();
}

export async function createWorktree(
  repoPath: string,
  ref: string,
  destination: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await gitOrThrow(repoPath, ['worktree', 'add', '--detach', '--force', destination, ref]);
}

export async function removeWorktree(repoPath: string, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    await gitText(repoPath, ['worktree', 'remove', '--force', destination]);
    await removePath(destination);
  }
  await gitText(repoPath, ['worktree', 'prune']);
}

export async function applyWorkingTreeOverlay(
  repoPath: string,
  destination: string,
): Promise<void> {
  const changes = await listDirtyChanges(repoPath);
  for (const change of changes) {
    if (change.status === 'R' && change.oldPath) {
      await removePath(safeJoin(destination, change.oldPath));
    }
    if (change.status === 'D') {
      await removePath(safeJoin(destination, change.path));
      continue;
    }
    const source = safeJoin(repoPath, change.path);
    const target = safeJoin(destination, change.path);
    await copyPathPreservingMode(source, target);
  }
}

export async function addLocalExclude(repoPath: string, entry: string): Promise<boolean> {
  try {
    const commonDirResult = await gitText(repoPath, ['rev-parse', '--git-common-dir']);
    if (commonDirResult.exitCode !== 0) {
      return false;
    }
    const commonDir = path.isAbsolute(commonDirResult.stdout.trim())
      ? commonDirResult.stdout.trim()
      : path.resolve(repoPath, commonDirResult.stdout.trim());
    const excludePath = path.join(commonDir, 'info', 'exclude');
    await mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (existing.split(/\r?\n/).includes(entry)) {
      return true;
    }
    const suffix = existing && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${suffix}${entry}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function getGitVersion(): Promise<string | undefined> {
  const result = await gitText(process.cwd(), ['--version']);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}
