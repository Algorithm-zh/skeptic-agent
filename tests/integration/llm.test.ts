import { execa } from 'execa';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyRepo } from '../../src/verify/orchestrator';

const API_KEY_ENV = 'SKEPTIC_TEST_LLM_KEY';
const API_KEY = 'test-key-not-a-secret';

const FIXED_SOURCE = `export function applyDiscount(price) {
  return price * 0.9;
}
`;

const BUGGY_SOURCE = `export function applyDiscount(price) {
  return price;
}
`;

const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a ten percent discount', () => {
  assert.equal(applyDiscount(100), 90);
});
`;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    reject: false,
    encoding: 'utf8',
    stripFinalNewline: false,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = path.join(root, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

describe('LLM claim extraction is advisory', () => {
  it('cannot flip a failed regression or smuggle in supported evidence', async () => {
    const requests: Array<{ authorization?: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const content = [
          '```json',
          JSON.stringify({
            claims: [
              {
                text: 'All tests pass.',
                type: 'tests_pass',
                checkId: 'unit',
                status: 'supported',
                material: true,
                evidence: ['check:unit (passed)'],
              },
            ],
            verdict: 'verified',
          }),
          '```',
        ].join('\n');
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const root = await mkdtemp(path.join(os.tmpdir(), 'skeptic-llm-'));
    const repoRoot = path.join(root, 'repo');

    try {
      await writeFiles(repoRoot, {
        'package.json': JSON.stringify({ name: 'llm-fixture', private: true, type: 'module' }, null, 2),
        'src/price.js': FIXED_SOURCE,
        'tests/price.test.js': TEST_FILE,
        '.gitignore': '.skeptic/\n',
        'skeptic.yml': `version: 1

checks:
  - id: unit
    name: Unit tests
    run: node --test
    required: true
    timeoutSec: 60

llm:
  enabled: true
  baseUrl: http://127.0.0.1:${port}/v1
  model: injection-fixture
  apiKeyEnv: ${API_KEY_ENV}
  timeoutSec: 10
`,
      });

      await git(repoRoot, ['-c', 'init.defaultBranch=main', 'init', '-q']);
      await git(repoRoot, ['config', 'core.autocrlf', 'false']);
      await git(repoRoot, ['config', 'core.eol', 'lf']);
      await git(repoRoot, ['add', '-A']);
      await git(repoRoot, [
        '-c',
        'user.name=Skeptic Test',
        '-c',
        'user.email=test@skeptic.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'passing base',
      ]);

      await writeFile(path.join(repoRoot, 'src', 'price.js'), BUGGY_SOURCE, 'utf8');

      const withoutLlm = await verifyRepo({
        repoPath: repoRoot,
        llm: false,
        claimsText: 'All done.',
      });

      process.env[API_KEY_ENV] = API_KEY;
      const withLlm = await verifyRepo({
        repoPath: repoRoot,
        llm: true,
        claimsText: 'All done.',
      });

      expect(withoutLlm.receipt.verdict.level).toBe('failed');
      expect(withLlm.receipt.verdict.level).toBe(withoutLlm.receipt.verdict.level);
      expect(withoutLlm.receipt.claims).toEqual([]);
      expect(withLlm.receipt.claims.some((claim) => claim.source === 'llm')).toBe(true);
      expect(withLlm.receipt.claims.every((claim) => claim.status !== 'supported')).toBe(true);
      expect(requests.length).toBe(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${API_KEY}`);
      expect(requests[0]?.body).toContain('untrusted DATA');
      expect(requests[0]?.body).toContain('All done.');
      expect(withLlm.receipt.verdict.level).not.toBe('verified');
    } finally {
      delete process.env[API_KEY_ENV];
      await rm(root, { recursive: true, force: true });
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });
});
