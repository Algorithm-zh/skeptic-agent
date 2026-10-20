import { SkepticError } from '../errors';
import type { Receipt } from '../types';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateReceiptShape(value: unknown): Receipt {
  if (!isObject(value)) {
    throw new SkepticError('RECEIPT_INVALID', 'Receipt is not a JSON object.');
  }
  if (value.schemaVersion !== 1) {
    throw new SkepticError(
      'RECEIPT_INVALID',
      `Unsupported receipt schema version: ${String(value.schemaVersion)}`,
    );
  }
  for (const key of ['tool', 'input', 'config', 'environment', 'verdict', 'artifacts'] as const) {
    if (!isObject(value[key])) {
      throw new SkepticError('RECEIPT_INVALID', `Receipt is missing object field "${key}".`);
    }
  }
  for (const key of ['checks', 'reproductions', 'claims', 'limitations'] as const) {
    if (!Array.isArray(value[key])) {
      throw new SkepticError('RECEIPT_INVALID', `Receipt is missing array field "${key}".`);
    }
  }
  if (!isObject(value.forensics) || !Array.isArray(value.forensics.findings)) {
    throw new SkepticError('RECEIPT_INVALID', 'Receipt is missing forensics.findings.');
  }
  if (typeof value.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.receiptSha256)) {
    throw new SkepticError('RECEIPT_INVALID', 'Receipt has no valid SHA-256 fingerprint.');
  }
  return value as unknown as Receipt;
}
