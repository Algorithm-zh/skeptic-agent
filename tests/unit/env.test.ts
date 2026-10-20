import { afterEach, describe, expect, it } from 'vitest';
import { createCleanEnv } from '../../src/exec/env';

const TOUCHED = [
  'SKEPTIC_TEST_SECRET',
  'SKEPTIC_TEST_TOKEN',
  'GITHUB_TOKEN',
  'NODE_OPTIONS',
  'SKEPTIC_PASS_TOKEN',
];

afterEach(() => {
  for (const key of TOUCHED) {
    delete process.env[key];
  }
});

describe('createCleanEnv', () => {
  it('drops secrets and execution overrides', () => {
    process.env.SKEPTIC_TEST_SECRET = 'super-secret';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.NODE_OPTIONS = '--inspect';

    const env = createCleanEnv();

    expect(env.SKEPTIC_TEST_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('keeps only explicitly passed variables', () => {
    process.env.SKEPTIC_PASS_TOKEN = 'allowed';

    const env = createCleanEnv(['SKEPTIC_PASS_TOKEN']);

    expect(env.SKEPTIC_PASS_TOKEN).toBe('allowed');
  });

  it('applies configured values after filtering', () => {
    const env = createCleanEnv([], { CUSTOM_SETTING: 'enabled' });
    expect(env.CUSTOM_SETTING).toBe('enabled');
  });

  it('removes NODE_OPTIONS even when configured explicitly', () => {
    const env = createCleanEnv([], { NODE_OPTIONS: '--require evil' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('preserves the path and sets deterministic defaults', () => {
    const env = createCleanEnv();
    expect(env.PATH ?? env.Path).toBeTruthy();
    expect(env.CI).toBeTruthy();
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.TERM).toBeTruthy();
  });
});
