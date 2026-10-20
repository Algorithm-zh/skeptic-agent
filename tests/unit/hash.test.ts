import { describe, expect, it } from 'vitest';
import { finalizeReceipt, verifyReceiptHash } from '../../src/receipt/hash';
import { canonicalJson, sha256 } from '../../src/util/hash';
import type { Receipt } from '../../src/types';

function sampleReceipt(): Receipt {
  return finalizeReceipt({
    schemaVersion: 1,
    tool: { name: 'skeptic', version: '0.1.0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    input: {
      repository: 'fixture',
      baseRef: 'HEAD',
      headRef: null,
      baseSha: 'a'.repeat(40),
      headSha: null,
      dirty: true,
      diffSha256: 'b'.repeat(64),
      changedFiles: 1,
    },
    config: { source: 'base', trusted: true, sha256: 'c'.repeat(64), modified: false },
    environment: { platform: 'win32', arch: 'x64', node: 'v24.0.0' },
    checks: [],
    reproductions: [],
    forensics: { findings: [], hardCount: 0, softCount: 0 },
    claims: [],
    verdict: { level: 'verified', reasons: ['All required checks passed.'] },
    limitations: ['not a sandbox'],
    artifacts: {
      logsDir: '.skeptic/runs/x/logs',
      receiptPath: '.skeptic/runs/x/receipt.json',
      reportPath: '.skeptic/runs/x/report.md',
    },
  });
}

describe('sha256', () => {
  it('hashes strings and buffers consistently', () => {
    expect(sha256('skeptic')).toBe(sha256(Buffer.from('skeptic', 'utf8')));
    expect(sha256('skeptic')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively', () => {
    const left = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const right = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(left).toBe(right);
    expect(left).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson({ values: ['b', 'a'] })).toBe('{"values":["b","a"]}');
  });

  it('drops undefined object values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('receipt hash', () => {
  it('finalizes a stable hash and verifies it', () => {
    const receipt = sampleReceipt();
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyReceiptHash(receipt)).toBe(true);
    expect(verifyReceiptHash(sampleReceipt())).toBe(true);
  });

  it('detects tampering', () => {
    const receipt = sampleReceipt();
    receipt.verdict.level = 'failed';
    expect(verifyReceiptHash(receipt)).toBe(false);
  });
});
