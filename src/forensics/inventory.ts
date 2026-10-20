import { readFile } from 'node:fs/promises';
import { listWorktreeFiles } from '../git/git';
import { safeJoin } from '../util/fs';
import { isTestFilePath } from './paths';
import type { Inventory, TestFileStats } from '../types';

const MAX_TEST_FILES = 400;
const MAX_FILE_BYTES = 1024 * 1024;

const TEST_DECLARATION_PATTERNS: RegExp[] = [
  /\b(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|failing|each))?\s*\(/g,
  /\bDeno\.test\s*\(/g,
  /^\s*(?:async\s+)?def\s+test_\w+\s*\(/gm,
  /\bfunc\s+Test\w*\s*\(/g,
  /^\s*#\[(?:tokio::)?test\]/gm,
  /^\s*@Test\b/gm,
  /^\s*\[(?:Fact|Theory|Test|TestMethod)\b/gm,
  /\bfunction\s+test\w*\s*\(/gi,
  /^\s*(?:it|test|describe|context)\s+['"]/gm,
];

const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\s*\(/g,
  /\bassert\s*\(/g,
  /\bassert\.[A-Za-z_]\w*\s*\(/g,
  /\bassert_eq!\s*\(/g,
  /\bassert!\s*\(/g,
  /\bself\.assert\w+\s*\(/g,
  /^\s*assert\s+[^=\s]/gm,
  /\.should\b/g,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\b(?:EXPECT|ASSERT)_[A-Z_]+\s*\(/g,
];

function countMatches(content: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const _match of content.matchAll(pattern)) {
      count += 1;
    }
  }
  return count;
}

async function inspectFile(rootPath: string, filePath: string): Promise<TestFileStats | undefined> {
  try {
    const buffer = await readFile(safeJoin(rootPath, filePath));
    if (buffer.length > MAX_FILE_BYTES || buffer.subarray(0, 8192).includes(0)) {
      return undefined;
    }
    const content = buffer.toString('utf8');
    return {
      tests: countMatches(content, TEST_DECLARATION_PATTERNS),
      assertions: countMatches(content, ASSERTION_PATTERNS),
    };
  } catch {
    return undefined;
  }
}

export async function buildInventory(rootPath: string): Promise<Inventory> {
  const files = (await listWorktreeFiles(rootPath)).filter(isTestFilePath);
  const selected = files.slice(0, MAX_TEST_FILES);
  const fileTests: Record<string, TestFileStats> = {};
  let partial = files.length > MAX_TEST_FILES;

  for (const filePath of selected) {
    const stats = await inspectFile(rootPath, filePath);
    if (!stats) {
      partial = true;
      continue;
    }
    fileTests[filePath] = stats;
  }

  const values = Object.values(fileTests);
  return {
    testFiles: values.length,
    testCount: values.reduce((total, stats) => total + stats.tests, 0),
    assertionCount: values.reduce((total, stats) => total + stats.assertions, 0),
    files: Object.keys(fileTests).sort(),
    fileTests,
    partial,
  };
}
