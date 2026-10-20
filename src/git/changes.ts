import { diffLines } from 'diff';
import { readFileAtRef, readWorkingFile, type FileSnapshot, type RawChange } from './git';
import { canonicalJson, sha256 } from '../util/hash';
import type { FileChange, FileLine } from '../types';

const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const MAX_LINES_PER_SIDE = 500;

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  const normalized = value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function collectLines(
  baseText: string,
  headText: string,
): { addedLines: FileLine[]; removedLines: FileLine[]; additions: number; deletions: number } {
  const parts = diffLines(baseText, headText);
  const addedLines: FileLine[] = [];
  const removedLines: FileLine[] = [];
  let additions = 0;
  let deletions = 0;
  let baseLine = 1;
  let headLine = 1;

  for (const part of parts) {
    const count = part.count ?? splitLines(part.value).length;
    if (part.added) {
      additions += count;
      if (addedLines.length < MAX_LINES_PER_SIDE) {
        for (const text of splitLines(part.value)) {
          if (addedLines.length >= MAX_LINES_PER_SIDE) break;
          addedLines.push({ line: headLine, text });
          headLine += 1;
        }
      }
      headLine += Math.max(0, count - splitLines(part.value).length);
    } else if (part.removed) {
      deletions += count;
      if (removedLines.length < MAX_LINES_PER_SIDE) {
        for (const text of splitLines(part.value)) {
          if (removedLines.length >= MAX_LINES_PER_SIDE) break;
          removedLines.push({ line: baseLine, text });
          baseLine += 1;
        }
      }
      baseLine += Math.max(0, count - splitLines(part.value).length);
    } else {
      baseLine += count;
      headLine += count;
    }
  }

  return { addedLines, removedLines, additions, deletions };
}

function sameContent(left?: FileSnapshot, right?: FileSnapshot): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.buffer.equals(right.buffer);
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export async function buildFileChange(
  repoPath: string,
  raw: RawChange,
  baseRef: string,
  headRef?: string,
): Promise<FileChange> {
  const basePath = raw.oldPath ?? raw.path;
  const readsBase = raw.status !== 'A' && raw.status !== 'U';
  const readsHead = raw.status !== 'D';

  const baseSnapshot = readsBase ? await readFileAtRef(repoPath, baseRef, basePath) : undefined;
  const headSnapshot = readsHead
    ? headRef
      ? await readFileAtRef(repoPath, headRef, raw.path)
      : await readWorkingFile(repoPath, raw.path)
    : undefined;

  const isBinary = Boolean(baseSnapshot?.isBinary || headSnapshot?.isBinary);
  const unchangedContent = !isBinary && sameContent(baseSnapshot, headSnapshot);

  let additions = 0;
  let deletions = 0;
  let addedLines: FileLine[] = [];
  let removedLines: FileLine[] = [];

  if (!isBinary && !unchangedContent) {
    const baseText = baseSnapshot ? normalize(baseSnapshot.text) : '';
    const headText = headSnapshot ? normalize(headSnapshot.text) : '';
    if (baseText.length + headText.length <= MAX_DIFF_CHARS) {
      const lines = collectLines(baseText, headText);
      additions = lines.additions;
      deletions = lines.deletions;
      addedLines = lines.addedLines;
      removedLines = lines.removedLines;
    } else {
      additions = headText ? splitLines(headText).length : 0;
      deletions = baseText ? splitLines(baseText).length : 0;
    }
  }

  return {
    status: raw.status,
    path: raw.path,
    oldPath: raw.oldPath,
    isBinary,
    additions,
    deletions,
    addedLines,
    removedLines,
    baseSha256: baseSnapshot ? sha256(baseSnapshot.buffer) : '',
    headSha256: headSnapshot ? sha256(headSnapshot.buffer) : '',
  };
}

export async function buildFileChanges(
  repoPath: string,
  rawChanges: RawChange[],
  baseRef: string,
  headRef?: string,
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const raw of rawChanges) {
    changes.push(await buildFileChange(repoPath, raw, baseRef, headRef));
  }
  return changes;
}

export function diffFingerprint(changes: FileChange[]): string {
  const compact = changes
    .map((change) => ({
      status: change.status,
      path: change.path,
      oldPath: change.oldPath ?? null,
      baseSha256: change.baseSha256,
      headSha256: change.headSha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(canonicalJson(compact));
}
