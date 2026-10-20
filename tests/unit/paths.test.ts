import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTED } from '../../src/config/schema';
import {
  globToRegExp,
  isCiFile,
  isLockfile,
  isProtectedPath,
  isTestConfigFile,
  isTestFilePath,
  normalizeRepoPath,
} from '../../src/forensics/paths';

describe('isTestFilePath', () => {
  it.each([
    'tests/price.test.js',
    'test/unit/price.ts',
    'src/price.test.ts',
    'src/price.spec.tsx',
    '__tests__/price.js',
    'test_price.py',
    'price_test.go',
    'PriceTest.java',
  ])('detects %s', (filePath) => {
    expect(isTestFilePath(filePath)).toBe(true);
  });

  it.each([
    'src/price.js',
    'docs/testing.md',
    'node_modules/pkg/tests/price.test.js',
    'dist/tests/price.test.js',
    '.skeptic/runs/x/tests/price.test.js',
    'src/latest.ts',
  ])('ignores %s', (filePath) => {
    expect(isTestFilePath(filePath)).toBe(false);
  });
});

describe('file classification', () => {
  it('detects CI workflows', () => {
    expect(isCiFile('.github/workflows/ci.yml')).toBe(true);
    expect(isCiFile('.github/workflows/release.yaml')).toBe(true);
    expect(isCiFile('.github/actions/ci.yml')).toBe(false);
  });

  it('detects lockfiles', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('nested/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('package.json')).toBe(false);
  });

  it('detects test configuration files', () => {
    expect(isTestConfigFile('vitest.config.ts')).toBe(true);
    expect(isTestConfigFile('nested/jest.config.js')).toBe(true);
    expect(isTestConfigFile('pyproject.toml')).toBe(true);
    expect(isTestConfigFile('package.json')).toBe(true);
    expect(isTestConfigFile('src/app.ts')).toBe(false);
  });
});

describe('normalizeRepoPath', () => {
  it('normalizes separators and leading dot segments', () => {
    expect(normalizeRepoPath('.\\tests\\a.test.ts')).toBe('tests/a.test.ts');
    expect(normalizeRepoPath('./tests/a.test.ts')).toBe('tests/a.test.ts');
  });
});

describe('globToRegExp', () => {
  it('matches single-star segments', () => {
    expect(globToRegExp('tests/*.ts').test('tests/a.ts')).toBe(true);
    expect(globToRegExp('tests/*.ts').test('tests/nested/a.ts')).toBe(false);
  });

  it('matches recursive globs at the root and nested levels', () => {
    expect(globToRegExp('tests/**').test('tests/a.test.ts')).toBe(true);
    expect(globToRegExp('tests/**').test('tests/nested/a.test.ts')).toBe(true);
    expect(globToRegExp('**/*.spec.*').test('price.spec.ts')).toBe(true);
    expect(globToRegExp('**/*.spec.*').test('src/price.spec.ts')).toBe(true);
  });

  it('escapes regular expression characters', () => {
    expect(globToRegExp('skeptic.yml').test('skeptic.yml')).toBe(true);
    expect(globToRegExp('skeptic.yml').test('skepticXYml')).toBe(false);
    expect(globToRegExp('src/(a)+/file.ts').test('src/(a)+/file.ts')).toBe(true);
  });
});

describe('isProtectedPath', () => {
  it('matches default protected paths', () => {
    expect(isProtectedPath('tests/price.test.js', DEFAULT_PROTECTED)).toBe(true);
    expect(isProtectedPath('package-lock.json', DEFAULT_PROTECTED)).toBe(true);
    expect(isProtectedPath('.github/workflows/ci.yml', DEFAULT_PROTECTED)).toBe(true);
    expect(isProtectedPath('src/price.js', DEFAULT_PROTECTED)).toBe(false);
  });

  it('matches explicit custom patterns', () => {
    expect(isProtectedPath('docs/guide.md', ['docs/**'])).toBe(true);
    expect(isProtectedPath('./docs/guide.md', ['docs/**'])).toBe(true);
    expect(isProtectedPath('docs', ['docs/**'])).toBe(false);
  });
});
