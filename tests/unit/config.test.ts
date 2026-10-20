import { describe, expect, it } from 'vitest';
import { normalizeConfigText, parseConfigText } from '../../src/config/load';
import { DEFAULT_PROTECTED } from '../../src/config/schema';
import { SkepticError } from '../../src/errors';

const MINIMAL = `version: 1
checks:
  - id: unit
    run: node --test
`;

describe('parseConfigText', () => {
  it('applies defaults', () => {
    const config = parseConfigText(MINIMAL);
    expect(config.checks).toHaveLength(1);
    expect(config.checks[0]).toEqual({
      id: 'unit',
      run: 'node --test',
      required: true,
      timeoutSec: 300,
    });
    expect(config.reproductions).toEqual([]);
    expect(config.protected).toEqual(DEFAULT_PROTECTED);
    expect(config.env).toEqual({ pass: [], set: {} });
    expect(config.allowScripts).toBe(false);
    expect(config.llm.enabled).toBe(false);
    expect(config.llm.apiKeyEnv).toBe('SKEPTIC_API_KEY');
  });

  it('normalizes CRLF before hashing and comparison', () => {
    expect(normalizeConfigText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('rejects duplicate check ids', () => {
    const text = `version: 1
checks:
  - id: unit
    run: node --test
  - id: unit
    run: npm test
`;
    expect(() => parseConfigText(text)).toThrowError(/duplicate check id: unit/);
  });

  it('rejects unknown keys', () => {
    const text = `version: 1
checks:
  - id: unit
    run: node --test
unexpected: true
`;
    expect(() => parseConfigText(text)).toThrowError(SkepticError);
  });

  it('rejects invalid timeouts', () => {
    const text = `version: 1
checks:
  - id: unit
    run: node --test
    timeoutSec: -1
`;
    expect(() => parseConfigText(text)).toThrowError(/timeoutSec/);
  });

  it('rejects an empty check list', () => {
    expect(() => parseConfigText('version: 1\nchecks: []\n')).toThrowError(/checks/);
  });

  it('parses reproductions, env, and llm settings', () => {
    const config = parseConfigText(`version: 1
checks:
  - id: unit
    run: node --test
reproductions:
  - id: issue-1
    name: "Issue #1"
    run: node --test tests/price.test.js
env:
  pass: [CI]
  set:
    NODE_ENV: test
allowScripts: true
llm:
  enabled: true
  baseUrl: http://127.0.0.1:1234/v1
  model: local-model
  apiKeyEnv: TEST_KEY
`);
    expect(config.reproductions[0]?.id).toBe('issue-1');
    expect(config.reproductions[0]?.expect).toBe('fail-before-pass-after');
    expect(config.env.pass).toEqual(['CI']);
    expect(config.env.set).toEqual({ NODE_ENV: 'test' });
    expect(config.allowScripts).toBe(true);
    expect(config.llm).toMatchObject({
      enabled: true,
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
      apiKeyEnv: 'TEST_KEY',
    });
  });

  it('rejects malformed yaml with a clear error', () => {
    expect(() => parseConfigText('checks: [')).toThrowError(SkepticError);
  });
});
