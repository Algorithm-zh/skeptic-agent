import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyPathPreservingMode,
  pathExists,
  readTextIfExists,
  removePath,
  safeJoin,
  writeText,
} from '../../src/util/fs';

describe('safeJoin', () => {
  const root = path.resolve(os.tmpdir(), 'skeptic-safe-join');

  it('resolves relative paths under the root', () => {
    expect(safeJoin(root, path.join('src', 'app.ts'))).toBe(path.join(root, 'src', 'app.ts'));
    expect(safeJoin(root, 'nested/file.txt')).toBe(path.join(root, 'nested', 'file.txt'));
  });

  it('rejects parent traversal', () => {
    expect(() => safeJoin(root, '..')).toThrowError(/escapes workspace|Unsafe/);
    expect(() => safeJoin(root, '../outside.txt')).toThrowError(/escapes workspace/);
    expect(() => safeJoin(root, 'nested/../../outside.txt')).toThrowError(/escapes workspace/);
  });

  it('rejects absolute paths', () => {
    expect(() => safeJoin(root, path.resolve(root, '..', 'outside.txt'))).toThrowError(/Unsafe/);
  });

  it('rejects null bytes and empty paths', () => {
    expect(() => safeJoin(root, 'bad\0name')).toThrowError(/Unsafe/);
    expect(() => safeJoin(root, '')).toThrowError(/Unsafe/);
  });

  it('rejects the root itself', () => {
    expect(() => safeJoin(root, '.')).toThrowError(/escapes workspace/);
  });
});

describe('file helpers', () => {
  it('writes nested files and reads them back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-fs-'));
    try {
      const target = path.join(root, 'deep', 'nested', 'file.txt');
      await writeText(target, 'hello');
      expect(await readFile(target, 'utf8')).toBe('hello');
      expect(await readTextIfExists(target)).toBe('hello');
      expect(await readTextIfExists(path.join(root, 'missing.txt'))).toBeUndefined();
      expect(await pathExists(target)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies files and preserves content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-copy-'));
    try {
      const source = path.join(root, 'source.txt');
      const destination = path.join(root, 'nested', 'copy.txt');
      await writeText(source, 'payload');
      await copyPathPreservingMode(source, destination);
      expect(await readFile(destination, 'utf8')).toBe('payload');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes missing paths without throwing', async () => {
    await expect(removePath(path.join(os.tmpdir(), 'skeptic-missing-never-created'))).resolves.toBeUndefined();
  });
});
