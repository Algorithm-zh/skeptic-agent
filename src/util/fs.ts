import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function safeJoin(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return target;
}

export async function ensureDir(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

export async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeText(target: string, content: string): Promise<void> {
  await ensureDir(path.dirname(target));
  await writeFile(target, content, 'utf8');
}

export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export async function copyPathPreservingMode(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination));
  const stats = await lstat(source);
  if (stats.isSymbolicLink()) {
    const linkTarget = await readlink(source);
    try {
      await unlink(destination);
    } catch {
      // Destination does not exist.
    }
    try {
      await symlink(linkTarget, destination);
      return;
    } catch {
      // Symlink privileges may be unavailable on Windows; fall back to a file copy.
    }
  }
  await copyFile(source, destination);
  try {
    await chmod(destination, stats.mode & 0o777);
  } catch {
    // File mode is advisory on Windows.
  }
}
