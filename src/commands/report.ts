import { readdir } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { SkepticError } from '../errors';
import { getRepoRoot } from '../git/git';
import { verifyReceiptHash } from '../receipt/hash';
import { renderMarkdown } from '../receipt/markdown';
import { readReceiptFile } from '../receipt/write';
import { pathExists } from '../util/fs';

export interface ReportOptions {
  file?: string;
  repoPath: string;
}

async function findLatestReceipt(repoPath: string): Promise<string> {
  const repoRoot = await getRepoRoot(repoPath);
  const runsDir = path.join(repoRoot, '.skeptic', 'runs');
  if (!(await pathExists(runsDir))) {
    throw new SkepticError(
      'NO_RECEIPTS',
      'No Skeptic runs were found.',
      'Run `skeptic verify` first.',
    );
  }
  const entries = await readdir(runsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const receiptPath = path.join(runsDir, candidate, 'receipt.json');
    if (await pathExists(receiptPath)) {
      return receiptPath;
    }
  }
  throw new SkepticError('NO_RECEIPTS', 'No receipt.json files were found.', 'Run `skeptic verify` first.');
}

export async function runReportCommand(options: ReportOptions): Promise<number> {
  let receiptPath = options.file;
  if (receiptPath) {
    receiptPath = path.resolve(process.cwd(), receiptPath);
    if (await pathExists(path.join(receiptPath, 'receipt.json'))) {
      receiptPath = path.join(receiptPath, 'receipt.json');
    }
  } else {
    receiptPath = await findLatestReceipt(options.repoPath);
  }

  const receipt = await readReceiptFile(receiptPath);
  process.stdout.write(`${renderMarkdown(receipt)}\n`);

  if (!verifyReceiptHash(receipt)) {
    process.stderr.write(
      `${pc.red('warning')} Receipt hash does not match its contents. The receipt was modified after it was written.\n`,
    );
    return 1;
  }
  return 0;
}
