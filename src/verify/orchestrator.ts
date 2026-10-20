import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseConfigText } from '../config/load';
import { createCleanEnv } from '../exec/env';
import { runCommand } from '../exec/runner';
import { buildInventory } from '../forensics/inventory';
import {
  countSeverities,
  runForensics,
  type HeadConfigState,
  type PackageManifest,
} from '../forensics/rules';
import {
  addLocalExclude,
  applyWorkingTreeOverlay,
  createWorktree,
  getGitVersion,
  getRepoRoot,
  getWorkingStatus,
  isWorkingTreeClean,
  listChangesRaw,
  readFileAtRef,
  readWorkingFile,
  removeWorktree,
  resolveCommit,
} from '../git/git';
import { buildFileChanges, diffFingerprint } from '../git/changes';
import { finalizeReceipt } from '../receipt/hash';
import { renderMarkdown } from '../receipt/markdown';
import { makeRunId, writeReceiptFiles } from '../receipt/write';
import { VERSION, TOOL_NAME } from '../version';
import { collectClaims, evaluateClaims } from './claims';
import { applyReproductionTaint, runReproductions } from './reproduction';
import { computeVerdict, exitCodeForVerdict } from './verdict';
import type {
  CheckAttribution,
  CheckResult,
  ConfigInfo,
  Receipt,
  ReproductionResult,
  RunResult,
  VerifyOptions,
  VerifyOutcome,
} from '../types';

const SETUP_TIMEOUT_MS = 600_000;

function emptySummary() {
  return {
    detected: false,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    zeroTests: false,
    allSkipped: false,
  };
}

function unavailableResult(message: string): RunResult {
  return {
    status: 'error',
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    logFile: '',
    logSha256: '',
    outputExcerpt: message,
    summary: emptySummary(),
  };
}

function attribute(check: CheckResult): CheckAttribution {
  if (!check.base) {
    return 'baseline_unavailable';
  }
  if (check.base.status === 'passed' && check.head?.status === 'failed') {
    return 'regression';
  }
  if (check.base.status === 'failed') {
    return 'pre_existing_failure';
  }
  return 'baseline_unavailable';
}

function sanitizeResult(
  result: RunResult | undefined,
  replacements: Array<[string, string]>,
): RunResult | undefined {
  if (!result) return undefined;
  let excerpt = result.outputExcerpt;
  for (const [from, to] of replacements) {
    excerpt = excerpt.split(from).join(to);
    const forward = from.replace(/\\/g, '/');
    if (forward !== from) {
      excerpt = excerpt.split(forward).join(to);
    }
  }
  return { ...result, outputExcerpt: excerpt };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function parseManifest(raw: string | undefined): PackageManifest | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return {
      scripts: stringRecord(parsed.scripts),
      dependencies: stringRecord(parsed.dependencies),
      devDependencies: stringRecord(parsed.devDependencies),
      optionalDependencies: stringRecord(parsed.optionalDependencies),
      peerDependencies: stringRecord(parsed.peerDependencies),
    };
  } catch {
    return undefined;
  }
}

async function readManifestAtRef(
  repoPath: string,
  ref: string | null,
  filePath: string,
): Promise<PackageManifest | undefined> {
  const snapshot = ref
    ? await readFileAtRef(repoPath, ref, filePath)
    : await readWorkingFile(repoPath, filePath);
  if (!snapshot || snapshot.isBinary) return undefined;
  return parseManifest(snapshot.text);
}

function headConfigState(
  configInfo: ConfigInfo,
  headRaw: string | undefined,
): { state: HeadConfigState; parsed: ReturnType<typeof parseConfigText> | null } {
  if (configInfo.source === 'override') {
    return { state: 'same', parsed: null };
  }
  if (!headRaw) {
    return { state: configInfo.modified ? 'missing' : 'same', parsed: null };
  }
  if (!configInfo.modified) {
    return { state: 'same', parsed: null };
  }
  try {
    return { state: 'modified', parsed: parseConfigText(headRaw, 'skeptic.yml at head') };
  } catch {
    return { state: 'invalid', parsed: null };
  }
}

async function cleanupWorktrees(
  repoRoot: string,
  baseDir: string,
  headDir: string,
  tmpRoot: string,
): Promise<void> {
  await removeWorktree(repoRoot, baseDir);
  await removeWorktree(repoRoot, headDir);
  await rm(tmpRoot, { recursive: true, force: true });
}

export async function verifyRepo(options: VerifyOptions): Promise<VerifyOutcome> {
  const progress = options.onProgress ?? (() => {});
  const repoRoot = await getRepoRoot(options.repoPath);
  const baseRef = options.base ?? 'HEAD';
  const baseSha = await resolveCommit(repoRoot, baseRef);
  const headSha = options.head ? await resolveCommit(repoRoot, options.head) : null;
  const headCheckout = headSha ?? (await resolveCommit(repoRoot, 'HEAD'));
  const dirty = headSha === null && !(await isWorkingTreeClean(repoRoot));

  const excluded = await addLocalExclude(repoRoot, '.skeptic/');
  if (!excluded) {
    progress('Warning: could not add .skeptic/ to .git/info/exclude; untracked artifacts may appear.');
  }
  const statusBefore = await getWorkingStatus(repoRoot);

  const loaded = await loadConfig({
    repoPath: repoRoot,
    baseRef: baseSha,
    headRef: headSha ?? undefined,
    configPath: options.configPath,
    trustConfig: options.trustConfig,
  });
  const config = loaded.config;
  const { state: headConfigStateValue, parsed: headConfig } = headConfigState(
    loaded.info,
    loaded.headRaw,
  );

  const runId = makeRunId();
  const runRoot = `.skeptic/runs/${runId}`;
  const logsDirAbsolute = path.join(repoRoot, runRoot, 'logs');
  await mkdir(logsDirAbsolute, { recursive: true });

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'skeptic-'));
  const baseDir = path.join(tmpRoot, 'base');
  const headDir = path.join(tmpRoot, 'head');
  let cleanedUp = false;

  try {
    progress(`Snapshotting ${baseSha.slice(0, 12)} and ${headSha ? headSha.slice(0, 12) : 'the working tree'}...`);
    await createWorktree(repoRoot, baseSha, baseDir);
    await createWorktree(repoRoot, headCheckout, headDir);
    if (!headSha) {
      await applyWorkingTreeOverlay(repoRoot, headDir);
    }

    const changes = await buildFileChanges(
      repoRoot,
      await listChangesRaw(repoRoot, baseSha, headSha ?? undefined),
      baseSha,
      headSha ?? undefined,
    );
    progress(`Found ${changes.length} changed file(s).`);

    const baseInventory = await buildInventory(baseDir);
    const headInventory = await buildInventory(headDir);

    const allowScripts = options.allowScripts ?? config.allowScripts;
    const env = createCleanEnv(config.env.pass, config.env.set);
    if (!allowScripts) {
      env.npm_config_ignore_scripts = 'true';
    }

    let setup: RunResult | undefined;
    let headReady = true;
    if (config.setup) {
      progress('Installing dependencies in the isolated head snapshot...');
      setup = await runCommand({
        command: config.setup,
        cwd: headDir,
        env,
        timeoutMs: SETUP_TIMEOUT_MS,
        logPath: path.join(logsDirAbsolute, 'setup-head.log'),
        logRef: `${runRoot}/logs/setup-head.log`,
        label: 'setup (head)',
      });
      headReady = setup.status === 'passed';
      if (!headReady) {
        progress('Head setup failed. Checks will not be executed.');
      }
    }

    const headChecks: CheckResult[] = [];
    if (headReady) {
      for (const check of config.checks) {
        const name = check.name ?? check.id;
        progress(`Running check "${name}" on the proposed code...`);
        const head = await runCommand({
          command: check.run,
          cwd: headDir,
          env,
          timeoutMs: check.timeoutSec * 1000,
          logPath: path.join(logsDirAbsolute, `${check.id}-head.log`),
          logRef: `${runRoot}/logs/${check.id}-head.log`,
          label: `check ${check.id} (head)`,
        });
        headChecks.push({
          id: check.id,
          name,
          required: check.required,
          command: check.run,
          head,
        });
      }
    } else {
      for (const check of config.checks) {
        headChecks.push({
          id: check.id,
          name: check.name ?? check.id,
          required: check.required,
          command: check.run,
          head: unavailableResult('Dependency setup failed; this check was not executed.'),
        });
      }
    }

    const checksNeedingBase = headChecks.filter(
      (check) =>
        check.required &&
        (check.head?.status === 'failed' || check.head?.status === 'error'),
    );
    const needBase = headReady && (checksNeedingBase.length > 0 || config.reproductions.length > 0);
    let baseReady = true;

    if (needBase) {
      if (config.setup) {
        progress('Installing dependencies in the isolated baseline snapshot...');
        const baseSetup = await runCommand({
          command: config.setup,
          cwd: baseDir,
          env,
          timeoutMs: SETUP_TIMEOUT_MS,
          logPath: path.join(logsDirAbsolute, 'setup-base.log'),
          logRef: `${runRoot}/logs/setup-base.log`,
          label: 'setup (base)',
        });
        baseReady = baseSetup.status === 'passed';
        if (!baseReady) {
          progress('Baseline setup failed. Baseline attribution is unavailable.');
        }
      }

      if (baseReady) {
        for (const check of checksNeedingBase) {
          progress(`Running check "${check.name}" on the baseline for attribution...`);
          check.base = await runCommand({
            command: check.command,
            cwd: baseDir,
            env,
            timeoutMs: (config.checks.find((entry) => entry.id === check.id)?.timeoutSec ?? 300) * 1000,
            logPath: path.join(logsDirAbsolute, `${check.id}-base.log`),
            logRef: `${runRoot}/logs/${check.id}-base.log`,
            label: `check ${check.id} (base)`,
          });
          check.attribution = attribute(check);
        }
      } else {
        for (const check of checksNeedingBase) {
          check.base = unavailableResult('Baseline setup failed; this check was not executed.');
          check.attribution = 'baseline_unavailable';
        }
      }
    }

    const reproductions: ReproductionResult[] = await runReproductions({
      reproductions: config.reproductions,
      env,
      paths: {
        baseDir,
        headDir,
        logsDir: logsDirAbsolute,
        logRoot: runRoot,
      },
      baseReady: baseReady && needBase,
      headReady,
      onProgress: progress,
    });

    const baseManifest = await readManifestAtRef(repoRoot, baseSha, 'package.json');
    const headManifest = await readManifestAtRef(repoRoot, headSha, 'package.json');

    const findings = runForensics({
      changes,
      baseInventory,
      headInventory,
      configInfo: loaded.info,
      baseConfig: config,
      headConfig,
      headConfigState: headConfigStateValue,
      headChecks,
      baseChecks: headChecks,
      reproductions,
      baseManifest,
      headManifest,
    });

    const taintedReproductions = applyReproductionTaint(
      reproductions,
      changes,
      baseInventory,
      headInventory,
      findings,
    );

    const llmEnabled = options.llm ?? config.llm.enabled;
    const claims = evaluateClaims(
      await collectClaims({
        text: options.claimsText,
        llmEnabled,
        llmConfig: config.llm,
        checkIds: config.checks.map((check) => check.id),
        onProgress: progress,
      }),
      {
        checks: headChecks,
        reproductions: taintedReproductions,
        findings,
      },
    );

    const verdict = computeVerdict({
      checks: headChecks,
      reproductions: taintedReproductions,
      findings,
      claims,
    });

    if (!options.keepWorktrees) {
      await cleanupWorktrees(repoRoot, baseDir, headDir, tmpRoot);
    }
    cleanedUp = true;

    if (options.keepWorktrees) {
      progress(`Kept isolated snapshots at ${tmpRoot}`);
    }

    const statusAfter = await getWorkingStatus(repoRoot);
    const severities = countSeverities(findings);
    const limitations = [
      'Skeptic executes code from the repository under verification. This is an isolated snapshot, not a security sandbox.',
      'Network access was not blocked during verification.',
      'Ignored files are not copied into the isolated snapshot; dependency setup must reconstruct the environment.',
      'Findings are deterministic heuristics, not proof of intent or semantic equivalence.',
      'Logs are stored separately and may contain sensitive output produced by the tested code.',
      'Receipt hashes provide integrity, not authenticity; they are not cryptographic signatures.',
      'LLM-extracted claims are advisory only and cannot change the verdict.',
    ];
    if (allowScripts) {
      limitations.push('Install lifecycle scripts were allowed (allowScripts is true).');
    }
    if (loaded.info.source === 'trusted-worktree') {
      limitations.push('The verification config was read from an uncommitted file explicitly trusted by the operator.');
    }
    if (headSha !== null) {
      limitations.push('Only the committed base/head range was verified; uncommitted working-tree changes were ignored.');
    }
    if (statusAfter !== statusBefore) {
      limitations.push('The repository working-tree status changed during verification; results may not correspond to one fixed input.');
    }

    const gitVersion = await getGitVersion();
    const artifacts = {
      logsDir: `${runRoot}/logs`,
      receiptPath: `${runRoot}/receipt.json`,
      reportPath: `${runRoot}/report.md`,
    };
    const pathReplacements: Array<[string, string]> = [
      [baseDir, '<base-snapshot>'],
      [headDir, '<head-snapshot>'],
      [tmpRoot, '<snapshot-root>'],
    ];
    const receiptChecks = headChecks.map((check) => ({
      ...check,
      head: sanitizeResult(check.head, pathReplacements),
      base: sanitizeResult(check.base, pathReplacements),
    }));
    const receiptReproductions = taintedReproductions.map((reproduction) => ({
      ...reproduction,
      base: sanitizeResult(reproduction.base, pathReplacements),
      head: sanitizeResult(reproduction.head, pathReplacements),
    }));

    const receipt = finalizeReceipt({
      schemaVersion: 1,
      tool: { name: TOOL_NAME, version: VERSION },
      createdAt: new Date().toISOString(),
      input: {
        repository: path.basename(repoRoot) || 'repository',
        baseRef,
        headRef: options.head ?? null,
        baseSha,
        headSha,
        dirty,
        diffSha256: diffFingerprint(changes),
        changedFiles: changes.length,
      },
      config: loaded.info,
      setup: sanitizeResult(setup, pathReplacements),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        git: gitVersion,
      },
      checks: receiptChecks,
      reproductions: receiptReproductions,
      forensics: {
        findings,
        hardCount: severities.hardCount,
        softCount: severities.softCount,
      },
      claims,
      verdict,
      limitations,
      artifacts,
    });

    const markdown = renderMarkdown(receipt);
    await writeReceiptFiles(repoRoot, receipt, markdown);

    return {
      receipt,
      receiptPath: artifacts.receiptPath,
      reportPath: artifacts.reportPath,
      markdown,
      exitCode: exitCodeForVerdict(verdict.level, options.failOn ?? 'unverified'),
    };
  } finally {
    if (!cleanedUp) {
      if (options.keepWorktrees) {
        progress(`Kept isolated snapshots at ${tmpRoot}`);
      } else {
        try {
          await cleanupWorktrees(repoRoot, baseDir, headDir, tmpRoot);
        } catch {
          progress(`Warning: could not remove isolated snapshots at ${tmpRoot}`);
        }
      }
    }
  }
}
