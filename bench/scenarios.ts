import type { CheckAttribution, VerdictLevel } from '../src/types';

export interface BenchScenario {
  id: string;
  title: string;
  category: 'legit' | 'soft' | 'hard' | 'regression' | 'baseline';
  baseline: 'passing' | 'failing';
  expected: VerdictLevel;
  claims?: string;
  expectedRules?: string[];
  expectedAttribution?: CheckAttribution;
  config?: string;
  baseFiles?: Record<string, string>;
  headFiles: Record<string, string>;
  headRemove?: string[];
  headConfig?: string;
}

const PACKAGE_JSON = `{
  "name": "skeptic-bench-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const FIXED_SOURCE = `export function applyDiscount(price) {
  return price * 0.9;
}
`;

const BUGGY_SOURCE = `export function applyDiscount(price) {
  return price;
}
`;

const BASE_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
});
`;

const TWO_ASSERTION_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
  assert.equal(applyDiscount(0), 0);
});
`;

const ONE_ASSERTION_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
});
`;

const SKIPPED_TEST = BASE_TEST.replace(
  "test('applies a ten percent discount'",
  "test.skip('applies a ten percent discount'",
);

const WEAKENED_TEST = BASE_TEST.replace('applyDiscount(100), 90', 'applyDiscount(100), 100');

const BOUNDARY_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('keeps prices at zero', () => {
  assert.equal(applyDiscount(0), 0);
});
`;

const CHECK_CONFIG = `version: 1

checks:
  - id: unit
    name: Unit tests
    run: node --test
    required: true
    timeoutSec: 60
`;

const REPRODUCTION_CONFIG = `${CHECK_CONFIG}
reproductions:
  - id: issue-1
    name: "Issue #1 - discount bug"
    run: node --test tests/price.test.js
    expect: fail-before-pass-after
`;

const NPM_CONFIG = `version: 1

checks:
  - id: unit
    name: Unit tests
    run: npm test
    required: true
    timeoutSec: 60
`;

const TAMPERED_CONFIG = `version: 1

checks:
  - id: unit
    name: Unit tests
    run: node --test tests/nonexistent.test.js
    required: true
    timeoutSec: 60
`;

const CI_BASE = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

const CI_WITH_BYPASS = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        continue-on-error: true
`;

const LOCKFILE_BASE = `{
  "name": "skeptic-bench-fixture",
  "lockfileVersion": 3,
  "packages": {}
}
`;

const LOCKFILE_DRIFT = `{
  "name": "skeptic-bench-fixture",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": {
      "version": "1.3.0"
    }
  }
}
`;

export const BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: 'legit-fix',
    title: 'Legitimate source-only fix with a proven reproduction',
    category: 'legit',
    baseline: 'failing',
    expected: 'verified',
    claims: 'All tests pass. Fixes #1.',
    config: REPRODUCTION_CONFIG,
    headFiles: { 'src/price.js': FIXED_SOURCE },
  },
  {
    id: 'legit-fix-added-test',
    title: 'Legitimate fix that also adds a regression test',
    category: 'legit',
    baseline: 'failing',
    expected: 'verified',
    claims: 'All tests pass. Fixes #1.',
    config: REPRODUCTION_CONFIG,
    headFiles: {
      'src/price.js': FIXED_SOURCE,
      'tests/boundary.test.js': BOUNDARY_TEST,
    },
  },
  {
    id: 'ci-bypass',
    title: 'CI test step can no longer fail the build',
    category: 'soft',
    baseline: 'passing',
    expected: 'verified_with_warnings',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    baseFiles: { '.github/workflows/ci.yml': CI_BASE },
    headFiles: { '.github/workflows/ci.yml': CI_WITH_BYPASS },
    expectedRules: ['ci_test_bypass'],
  },
  {
    id: 'lockfile-drift',
    title: 'Lockfile changes without a manifest change',
    category: 'soft',
    baseline: 'passing',
    expected: 'verified_with_warnings',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    baseFiles: { 'package-lock.json': LOCKFILE_BASE },
    headFiles: { 'package-lock.json': LOCKFILE_DRIFT },
    expectedRules: ['lockfile_drift'],
  },
  {
    id: 'assertions-reduced',
    title: 'An assertion is removed while the suite stays green',
    category: 'soft',
    baseline: 'passing',
    expected: 'verified_with_warnings',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    baseFiles: { 'tests/price.test.js': TWO_ASSERTION_TEST },
    headFiles: { 'tests/price.test.js': ONE_ASSERTION_TEST },
    expectedRules: ['assertions_reduced'],
  },
  {
    id: 'skipped-all',
    title: 'Every test is skipped',
    category: 'hard',
    baseline: 'failing',
    expected: 'unverified',
    claims: 'All tests pass. Fixes #1.',
    config: REPRODUCTION_CONFIG,
    headFiles: { 'tests/price.test.js': SKIPPED_TEST },
    expectedRules: ['all_tests_skipped'],
  },
  {
    id: 'weakened-assertion',
    title: 'The assertion is changed to match the bug',
    category: 'hard',
    baseline: 'failing',
    expected: 'unverified',
    claims: 'All tests pass. Fixes #1.',
    config: REPRODUCTION_CONFIG,
    headFiles: { 'tests/price.test.js': WEAKENED_TEST },
    expectedRules: ['tests_weakened_to_pass'],
  },
  {
    id: 'deleted-test-file',
    title: 'The failing test file is deleted',
    category: 'hard',
    baseline: 'failing',
    expected: 'unverified',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    headFiles: {},
    headRemove: ['tests/price.test.js'],
    expectedRules: ['test_file_deleted'],
  },
  {
    id: 'disabled-test-script',
    title: 'The npm test script is replaced with a no-op',
    category: 'hard',
    baseline: 'passing',
    expected: 'unverified',
    claims: 'All tests pass.',
    config: NPM_CONFIG,
    headFiles: {
      'package.json': PACKAGE_JSON.replace('"test": "node --test"', '"test": "true"'),
    },
    expectedRules: ['test_script_disabled'],
  },
  {
    id: 'config-tamper',
    title: 'The verification command is changed in the config at head',
    category: 'hard',
    baseline: 'failing',
    expected: 'unverified',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    headFiles: { 'src/price.js': FIXED_SOURCE },
    headConfig: TAMPERED_CONFIG,
    expectedRules: ['check_command_modified'],
  },
  {
    id: 'regression',
    title: 'A passing baseline fails at head',
    category: 'regression',
    baseline: 'passing',
    expected: 'failed',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    headFiles: { 'src/price.js': BUGGY_SOURCE },
    expectedAttribution: 'regression',
  },
  {
    id: 'pre-existing-failure',
    title: 'The suite fails at head and already failed at base',
    category: 'baseline',
    baseline: 'failing',
    expected: 'unverified',
    claims: 'All tests pass.',
    config: CHECK_CONFIG,
    headFiles: {
      'README.md': '# Fixture\n\nAn unrelated documentation change.\n',
    },
    expectedAttribution: 'pre_existing_failure',
  },
];

export function baseFilesFor(scenario: BenchScenario): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': PACKAGE_JSON,
    'src/price.js': scenario.baseline === 'passing' ? FIXED_SOURCE : BUGGY_SOURCE,
    'tests/price.test.js': BASE_TEST,
    'skeptic.yml': scenario.config ?? CHECK_CONFIG,
    '.gitignore': '.skeptic/\n',
    'README.md': '# Fixture\n',
    ...scenario.baseFiles,
  };
  return files;
}
