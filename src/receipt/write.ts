import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SkepticError } from '../errors';
import { validateReceiptShape } from './schema';
import type { Receipt } from '../types';

export function makeRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

export async function writeReceiptFiles(
  repoRoot: string,
  receipt: Receipt,
  markdown: string,
): Promise<{ receiptAbsolutePath: string; reportAbsolutePath: string }> {
  const receiptAbsolutePath = path.resolve(repoRoot, receipt.artifacts.receiptPath);
  const reportAbsolutePath = path.resolve(repoRoot, receipt.artifacts.reportPath);
  await mkdir(path.dirname(receiptAbsolutePath), { recursive: true });
  await writeFile(receiptAbsolutePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(reportAbsolutePath, markdown, 'utf8');
  return { receiptAbsolutePath, reportAbsolutePath };
}

export async function readReceiptFile(filePath: string): Promise<Receipt> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new SkepticError('RECEIPT_NOT_FOUND', `Could not read receipt: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkepticError('RECEIPT_INVALID', `Receipt is not valid JSON: ${(error as Error).message}`);
  }
  return validateReceiptShape(parsed);
}
