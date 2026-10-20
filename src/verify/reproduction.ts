import path from 'node:path';
import type { ReproductionConfig } from '../config/schema';
import { runCommand } from '../exec/runner';
import { isTestFilePath } from '../forensics/paths';
import type {
  FileChange,
  Finding,
  Inventory,
  ReproductionResult,
  ReproductionStatus,
} from '../types';

const REPRODUCTION_TIMEOUT_MS = 300_000;

interface ReproductionPaths {
  baseDir: string;
  headDir: string;
  logsDir: string;
  logRoot: string;
}

export interface RunReproductionsOptions {
  reproductions: ReproductionConfig[];
  env: NodeJS.ProcessEnv;
  paths: ReproductionPaths;
  baseReady: boolean;
  headReady: boolean;
  onProgress?: (message: string) => void;
}

function classify(baseStatus: string, headStatus: string): ReproductionStatus {
  if (baseStatus === 'failed' && headStatus === 'passed') {
    return 'proven';
  }
  if (baseStatus === 'failed' && headStatus === 'failed') {
    return 'not_proven';
  }
  if (baseStatus === 'passed' && headStatus === 'passed') {
    return 'not_proven';
  }
  return 'inconclusive';
}

export async function runReproductions(
  options: RunReproductionsOptions,
): Promise<ReproductionResult[]> {
  const results: ReproductionResult[] = [];

  for (const reproduction of options.reproductions) {
    if (!options.baseReady || !options.headReady) {
      results.push({
        id: reproduction.id,
        name: reproduction.name ?? reproduction.id,
        command: reproduction.run,
        status: 'inconclusive',
      });
      continue;
    }

    options.onProgress?.(`Reproduction ${reproduction.id}: running on the baseline...`);
    const base = await runCommand({
      command: reproduction.run,
      cwd: options.paths.baseDir,
      env: options.env,
      timeoutMs: REPRODUCTION_TIMEOUT_MS,
      logPath: path.join(options.paths.logsDir, `repro-${reproduction.id}-base.log`),
      logRef: `${options.paths.logRoot}/logs/repro-${reproduction.id}-base.log`,
      label: `reproduction ${reproduction.id} (base)`,
    });

    options.onProgress?.(`Reproduction ${reproduction.id}: running on the proposed code...`);
    const head = await runCommand({
      command: reproduction.run,
      cwd: options.paths.headDir,
      env: options.env,
      timeoutMs: REPRODUCTION_TIMEOUT_MS,
      logPath: path.join(options.paths.logsDir, `repro-${reproduction.id}-head.log`),
      logRef: `${options.paths.logRoot}/logs/repro-${reproduction.id}-head.log`,
      label: `reproduction ${reproduction.id} (head)`,
    });

    results.push({
      id: reproduction.id,
      name: reproduction.name ?? reproduction.id,
      command: reproduction.run,
      base,
      head,
      status: classify(base.status, head.status),
    });
  }

  return results;
}

const TAINTING_RULES = new Set([
  'test_file_deleted',
  'test_file_emptied',
  'tests_weakened_to_pass',
  'zero_tests_executed',
  'all_tests_skipped',
  'check_command_disabled',
  'check_command_modified',
  'check_removed',
  'check_downgraded',
  'test_script_disabled',
  'config_unparseable',
  'config_removed',
  'reproduction_modified',
]);

const GENERIC_TEST_COMMAND =
  /\b(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|vitest|jest|go\s+test|cargo\s+test|dotnet\s+test|make\s+test)\b/i;

export function applyReproductionTaint(
  reproductions: ReproductionResult[],
  changes: FileChange[],
  baseInventory: Inventory,
  headInventory: Inventory,
  findings: Finding[],
): ReproductionResult[] {
  const changedTestFiles = changes
    .flatMap((change) => [change.path, change.oldPath])
    .filter((filePath): filePath is string => filePath !== undefined && isTestFilePath(filePath));
  const hardIntegrity = findings.filter(
    (finding) => finding.severity === 'hard' && TAINTING_RULES.has(finding.rule),
  );
  const noNewTests = headInventory.testCount <= baseInventory.testCount;
  const netReduction = headInventory.testCount < baseInventory.testCount;

  return reproductions.map((reproduction) => {
    if (reproduction.status === 'inconclusive' || reproduction.status === 'tainted') {
      return reproduction;
    }

    const directReference = changedTestFiles.some((filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      const baseName = normalized.split('/').at(-1) ?? normalized;
      return reproduction.command.includes(normalized) || reproduction.command.includes(baseName);
    });
    const genericRun = GENERIC_TEST_COMMAND.test(reproduction.command);
    const repeatedChangedRun = genericRun && changedTestFiles.length > 0 && noNewTests;

    if (!directReference && !repeatedChangedRun && !netReduction && hardIntegrity.length === 0) {
      return reproduction;
    }

    const reasons: string[] = [];
    if (directReference) {
      reasons.push('the reproduction command runs a test file that was modified');
    }
    if (repeatedChangedRun) {
      reasons.push('the reproduction runs a suite whose tests changed without adding new tests');
    }
    if (netReduction) {
      reasons.push(
        `test declarations fell from ${baseInventory.testCount} to ${headInventory.testCount}`,
      );
    }
    if (hardIntegrity.length > 0) {
      reasons.push(`integrity finding: ${hardIntegrity[0]?.title}`);
    }

    return {
      ...reproduction,
      status: 'tainted',
      taint: `The proof is tainted because ${reasons.join('; ')}.`,
    };
  });
}
