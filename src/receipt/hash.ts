import { canonicalJson, sha256 } from '../util/hash';
import type { Receipt } from '../types';

export type ReceiptDraft = Omit<Receipt, 'receiptSha256'>;

export function finalizeReceipt(draft: ReceiptDraft): Receipt {
  return {
    ...draft,
    receiptSha256: sha256(canonicalJson(draft)),
  };
}

export function verifyReceiptHash(receipt: Receipt): boolean {
  const { receiptSha256, ...rest } = receipt;
  return sha256(canonicalJson(rest)) === receiptSha256;
}
