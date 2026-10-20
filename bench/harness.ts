import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyReceiptHash } from '../src/receipt/hash';
import { readReceiptFile } from '../src/receipt/write';
import { sha256 } from '../src/util/hash';
import { verifyRepo } from '../src/verify/orchestrator';
import type { Receipt, RunResult, VerifyOutcome } from '../src/types';
import { baseFilesFor, type BenchScenario } from './scenarios';

export interface ScenarioCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioRun {
  scenario: BenchScenario;
  repoRoot: string;
  outcome: VerifyOutcome;
  receipt: Receipt;
  report: string;
  checks: ScenarioCheck[];
  failures: ScenarioCheck[];
  cleanup: () => Promise<void>;
}

const BASE_GIT_ARGS = ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false'];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', [...BASE_GIT_ARGS, ...args], {
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

async function writeScenarioFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = path.join(root, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

async function createBaseRepo(scenario: BenchScenario, repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await writeScenarioFiles(repoRoot, baseFilesFor(scenario));
  await git(repoRoot, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await git(repoRoot, ['config', 'core.eol', 'lf']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, [
    '-c',
    'user.name=Skeptic Bench',
    '-c',
    'user.email=bench@skeptic.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'base fixture',
  ]);
}

async function applyHeadChanges(scenario: BenchScenario, repoRoot: string): Promise<void> {
  for (const filePath of scenario.headRemove ?? []) {
    await rm(path.join(repoRoot, filePath), { force: true });
  }
  await writeScenarioFiles(repoRoot, scenario.headFiles);
  if (scenario.headConfig !== undefined) {
    await writeScenarioFiles(repoRoot, { 'skeptic.yml': scenario.headConfig });
  }
}

async function readStatus(repoRoot: string): Promise<string> {
  return git(repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
}

async function indexPath(repoRoot: string): Promise<string> {
  const value = (await git(repoRoot, ['rev-parse', '--git-path', 'index'])).trim();
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

async function indexTree(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ['write-tree'])).trim();
}

async function indexBytes(repoRoot: string): Promise<string> {
  return sha256(await readFile(await indexPath(repoRoot)));
}

async function worktreeCount(repoRoot: string): Promise<number> {
  const output = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  return output.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

function collectRuns(receipt: Receipt): RunResult[] {
  const runs: RunResult[] = [];
  if (receipt.setup) {
    runs.push(receipt.setup);
  }
  for (const check of receipt.checks) {
    if (check.head) runs.push(check.head);
    if (check.base) runs.push(check.base);
  }
  for (const reproduction of receipt.reproductions) {
    if (reproduction.base) runs.push(reproduction.base);
    if (reproduction.head) runs.push(reproduction.head);
  }
  return runs;
}

function failureDetail(check: ScenarioCheck): string {
  return `${check.name}${check.detail ? `: ${check.detail}` : ''}`;
}

export async function runScenario(scenario: BenchScenario): Promise<ScenarioRun> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `skeptic-bench-${scenario.id}-`));
  const repoRoot = path.join(tempRoot, 'repo');
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    await createBaseRepo(scenario, repoRoot);
    await applyHeadChanges(scenario, repoRoot);

    const statusBefore = await readStatus(repoRoot);
    const treeBefore = await indexTree(repoRoot);
    const indexBefore = await indexBytes(repoRoot);
    const worktreesBefore = await worktreeCount(repoRoot);

    const outcome = await verifyRepo({
      repoPath: repoRoot,
      claimsText: scenario.claims,
      llm: false,
    });

    const statusAfter = await readStatus(repoRoot);
    const treeAfter = await indexTree(repoRoot);
    const indexAfter = await indexBytes(repoRoot);
    const worktreesAfter = await worktreeCount(repoRoot);

    const receiptPath = path.resolve(repoRoot, outcome.receiptPath);
    const reportPath = path.resolve(repoRoot, outcome.reportPath);
    const receipt = await readReceiptFile(receiptPath);
    const report = await readFile(reportPath, 'utf8');
    const receiptJson = JSON.stringify(receipt);

    const checks: ScenarioCheck[] = [];
    const add = (name: string, passed: boolean, detail?: string): void => {
      checks.push({ name, passed, detail });
    };

    const expectedExitCode =
      scenario.expected === 'verified' || scenario.expected === 'verified_with_warnings' ? 0 : 1;
    add(
      'verdict',
      receipt.verdict.level === scenario.expected,
      `expected ${scenario.expected}, received ${receipt.verdict.level} (${receipt.verdict.reasons.join('; ')})`,
    );
    add('exit code', outcome.exitCode === expectedExitCode, `expected ${expectedExitCode}, received ${outcome.exitCode}`);
    add('verdict has reasons', receipt.verdict.reasons.length > 0);
    add('receipt hash', verifyReceiptHash(receipt), 'stored hash does not match the receipt content');
    add('dirty input recorded', receipt.input.dirty === true);
    add('trusted base config', receipt.config.trusted && receipt.config.source === 'base');
    add('changed files recorded', receipt.input.changedFiles > 0, `received ${receipt.input.changedFiles}`);
    add(
      'diff fingerprint',
      /^[a-f0-9]{64}$/.test(receipt.input.diffSha256),
      receipt.input.diffSha256,
    );
    add(
      'forensics counts',
      receipt.forensics.hardCount === receipt.forensics.findings.filter((entry) => entry.severity === 'hard').length &&
        receipt.forensics.softCount === receipt.forensics.findings.filter((entry) => entry.severity === 'soft').length,
    );

    for (const rule of scenario.expectedRules ?? []) {
      add(
        `finding ${rule}`,
        receipt.forensics.findings.some((finding) => finding.rule === rule),
        `found: ${receipt.forensics.findings.map((finding) => finding.rule).join(', ') || '(none)'}`,
      );
    }

    if (scenario.expectedAttribution) {
      add(
        `attribution ${scenario.expectedAttribution}`,
        receipt.checks.some((check) => check.attribution === scenario.expectedAttribution),
        `found: ${receipt.checks.map((check) => `${check.id}=${check.attribution ?? 'none'}`).join(', ')}`,
      );
    }

    const materialClaims = receipt.claims.filter(
      (claim) => claim.material && claim.source !== 'llm',
    );
    if (scenario.expected === 'verified' || scenario.expected === 'verified_with_warnings') {
      add(
        'material claims supported',
        materialClaims.every((claim) => claim.status === 'supported'),
        materialClaims.map((claim) => `${claim.type}=${claim.status}`).join(', ') || '(no claims)',
      );
    } else {
      add(
        'claims not overstated',
        materialClaims.length === 0 ||
          materialClaims.some((claim) => claim.status === 'unsupported' || claim.status === 'contradicted'),
        materialClaims.map((claim) => `${claim.type}=${claim.status}`).join(', ') || '(no claims)',
      );
    }

    const safePath = repoRoot.replace(/\\/g, '/');
    add(
      'receipt has no absolute repo path',
      !receiptJson.includes(repoRoot) && !receiptJson.includes(safePath),
      'receipt contains the fixture repository path',
    );
    add(
      'report has no absolute repo path',
      !report.includes(repoRoot) && !report.includes(safePath),
      'report contains the fixture repository path',
    );

    const logFailures: string[] = [];
    for (const run of collectRuns(receipt)) {
      if (!run.logFile) continue;
      const absolute = path.resolve(repoRoot, run.logFile);
      if (!absolute.startsWith(repoRoot)) {
        logFailures.push(`${run.logFile} escapes the repository`);
        continue;
      }
      try {
        const content = await readFile(absolute);
        if (sha256(content) !== run.logSha256) {
          logFailures.push(`${run.logFile} hash mismatch`);
        }
      } catch {
        logFailures.push(`${run.logFile} missing`);
      }
    }
    add('log artifacts and hashes', logFailures.length === 0, logFailures.join('; '));

    add('report lists the verdict', report.toLowerCase().includes(receipt.verdict.level.replace(/_/g, ' ')) ||
      report.includes(receipt.verdict.level));

    add(
      'working tree unchanged',
      statusBefore === statusAfter,
      'git status changed during verification',
    );
    add('index tree unchanged', treeBefore === treeAfter, 'staged tree changed during verification');
    add('index bytes unchanged', indexBefore === indexAfter, 'index file changed during verification');
    add(
      'worktrees cleaned up',
      worktreesBefore === 1 && worktreesAfter === 1,
      `before: ${worktreesBefore}, after: ${worktreesAfter}`,
    );

    const failures = checks.filter((check) => !check.passed);
    return {
      scenario,
      repoRoot,
      outcome,
      receipt,
      report,
      checks,
      failures,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function formatFailure(check: ScenarioCheck): string {
  return failureDetail(check);
}
