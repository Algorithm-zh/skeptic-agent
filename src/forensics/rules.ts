import type { SkepticConfig } from '../config/schema';
import { canonicalJson } from '../util/hash';
import {
  isCiFile,
  isLockfile,
  isProtectedPath,
  isTestConfigFile,
  isTestFilePath,
  normalizeRepoPath,
} from './paths';
import type {
  CheckResult,
  ConfigInfo,
  FileChange,
  Finding,
  Inventory,
  ReproductionResult,
} from '../types';

export interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export type HeadConfigState = 'same' | 'modified' | 'missing' | 'invalid';

export interface ForensicsInput {
  changes: FileChange[];
  baseInventory: Inventory;
  headInventory: Inventory;
  configInfo: ConfigInfo;
  baseConfig: SkepticConfig;
  headConfig: SkepticConfig | null;
  headConfigState: HeadConfigState;
  headChecks: CheckResult[];
  baseChecks: CheckResult[];
  reproductions: ReproductionResult[];
  baseManifest?: PackageManifest;
  headManifest?: PackageManifest;
}

const DISABLED_COMMAND = /^(?:true|:|\/bin\/true|exit\s+0|echo(?:\s+.*)?)$/i;
const SKIP_MARKER =
  /(?:\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|^\s*#\[ignore(?:\([^)]*\))?\]|\b(?:it|test|describe)\.(?:skip|todo)\b)/;
const FOCUS_MARKER = /(?:\.only\s*\(|^\s*fit\s*\(|^\s*fdescribe\s*\(|\b(?:it|test|describe)\.only\b)/;
const ASSERTION_LINE =
  /\bexpect\s*\(|\bassert(?:\.[A-Za-z_]\w*\s*\(|\s*\()|\.should\b|assert_eq!|self\.assert\w*\s*\(|\bt\.(?:Error|Fatal)\s*\(/;
const TEST_INVOCATION =
  /\b(?:npm\s+(?:run\s+)?test|npx\s+(?:vitest|jest)|vitest|jest|pytest|go\s+test|cargo\s+test|dotnet\s+test|make\s+test)\b/i;
const CI_BYPASS =
  /(?:continue-on-error:\s*true|\|\|\s*true|if:\s*(?:false|\$\{\{\s*false\s*\}\})|--passWithNoTests|--no-fail)/i;
const TEST_CONFIG_WEAKENING =
  /(?:passWithNoTests|testPathIgnorePatterns|coveragePathIgnorePatterns|coverageThreshold|thresholds\s*:|fail_under|omit\s*:|\bexclude\s*:\s*\[|--coverage=false)/i;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

function createFindingCollector() {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (finding: Finding) => {
    const key = `${finding.rule}:${finding.file ?? ''}:${finding.line ?? ''}:${finding.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  return { findings, add };
}

function checkConfigChanges(
  input: ForensicsInput,
  add: (finding: Finding) => void,
): boolean {
  if (input.headConfigState === 'missing') {
    add({
      rule: 'config_removed',
      severity: 'hard',
      title: 'Verification config was removed',
      message: 'skeptic.yml existed at the base ref but is missing at head. The trusted checks cannot be exchanged silently.',
      file: 'skeptic.yml',
    });
    return true;
  }
  if (input.headConfigState === 'invalid') {
    add({
      rule: 'config_unparseable',
      severity: 'hard',
      title: 'Verification config is unparseable at head',
      message: 'The head version of skeptic.yml cannot be parsed, so the verification contract cannot be compared.',
      file: 'skeptic.yml',
    });
    return true;
  }
  if (input.headConfigState === 'same') {
    return false;
  }

  const base = input.baseConfig;
  const head = input.headConfig;
  if (!head) {
    return false;
  }
  let hardConfigFinding = false;
  const headChecks = new Map(head.checks.map((check) => [check.id, check]));
  for (const baseCheck of base.checks) {
    const headCheck = headChecks.get(baseCheck.id);
    if (!headCheck) {
      hardConfigFinding = true;
      add({
        rule: 'check_removed',
        severity: 'hard',
        title: 'Required verification check was removed',
        message: `Check "${baseCheck.id}" exists in the trusted config but was removed at head.`,
        file: 'skeptic.yml',
        evidence: `base: ${baseCheck.run}`,
      });
      continue;
    }
    if (headCheck.run !== baseCheck.run) {
      hardConfigFinding = true;
      const disabled = DISABLED_COMMAND.test(headCheck.run.trim());
      add({
        rule: disabled ? 'check_command_disabled' : 'check_command_modified',
        severity: 'hard',
        title: disabled ? 'Verification command was disabled' : 'Verification command was changed',
        message: disabled
          ? `Check "${baseCheck.id}" was replaced with a no-op command at head.`
          : `Check "${baseCheck.id}" points at a different command at head.`,
        file: 'skeptic.yml',
        evidence: `base: ${baseCheck.run}\nhead: ${headCheck.run}`,
      });
    }
    if (baseCheck.required && !headCheck.required) {
      hardConfigFinding = true;
      add({
        rule: 'check_downgraded',
        severity: 'hard',
        title: 'Required check was made optional',
        message: `Check "${baseCheck.id}" was required at base but is optional at head.`,
        file: 'skeptic.yml',
      });
    }
  }

  const headReproductions = new Map(head.reproductions.map((reproduction) => [reproduction.id, reproduction]));
  for (const baseReproduction of base.reproductions) {
    const headReproduction = headReproductions.get(baseReproduction.id);
    if (!headReproduction || headReproduction.run !== baseReproduction.run) {
      hardConfigFinding = true;
      add({
        rule: 'reproduction_modified',
        severity: 'hard',
        title: 'Configured reproduction was removed or changed',
        message: `Reproduction "${baseReproduction.id}" from the trusted config is no longer intact at head.`,
        file: 'skeptic.yml',
        evidence: `base: ${baseReproduction.run}${headReproduction ? `\nhead: ${headReproduction.run}` : ''}`,
      });
    }
  }

  if (canonicalJson(base.protected) !== canonicalJson(head.protected)) {
    add({
      rule: 'protection_modified',
      severity: 'soft',
      title: 'Protected path list was modified',
      message: 'The set of protected paths changed. Review whether the new list still covers tests, CI, and verification config.',
      file: 'skeptic.yml',
    });
  }

  if (!hardConfigFinding) {
    add({
      rule: 'config_modified',
      severity: 'soft',
      title: 'Verification config differs at head',
      message: 'The head version of skeptic.yml differs from the trusted base version. Skeptic ignored the head config and used the base version.',
      file: 'skeptic.yml',
    });
  }
  return hardConfigFinding;
}

function checkTestFiles(input: ForensicsInput, add: (finding: Finding) => void): void {
  const deleted = input.changes.filter(
    (change) =>
      (change.status === 'D' && isTestFilePath(change.path)) ||
      (change.status === 'R' && change.oldPath !== undefined && isTestFilePath(change.oldPath) && !isTestFilePath(change.path)),
  );
  const added = input.changes.filter(
    (change) =>
      (change.status === 'A' && isTestFilePath(change.path)) ||
      (change.status === 'R' && isTestFilePath(change.path)),
  );

  if (deleted.length > 0) {
    const netReduced = input.headInventory.testCount < input.baseInventory.testCount;
    if (added.length === 0 || netReduced) {
      for (const change of deleted.slice(0, 5)) {
        const evidencePath = change.oldPath ?? change.path;
        const baseStats = input.baseInventory.fileTests[evidencePath];
        add({
          rule: 'test_file_deleted',
          severity: 'hard',
          title: 'Test file was deleted',
          message: 'A test file was removed without an equivalent replacement. Tests that no longer exist cannot pass.',
          file: evidencePath,
          evidence: baseStats ? `${baseStats.tests} test declaration(s), ${baseStats.assertions} assertion(s) removed` : undefined,
        });
      }
    } else {
      add({
        rule: 'test_files_reorganized',
        severity: 'soft',
        title: 'Test files were reorganized',
        message: 'Test files were deleted or renamed while new test files were added. Verify that coverage was preserved.',
        file: deleted[0]?.oldPath ?? deleted[0]?.path,
      });
    }
  }

  for (const change of input.changes) {
    if (!isTestFilePath(change.path)) continue;
    const baseStats = change.oldPath
      ? input.baseInventory.fileTests[change.oldPath]
      : input.baseInventory.fileTests[change.path];
    const headStats = input.headInventory.fileTests[change.path];
    if (change.status === 'M' && baseStats && headStats && baseStats.tests > 0 && headStats.tests === 0) {
      add({
        rule: 'test_file_emptied',
        severity: 'hard',
        title: 'Test file no longer contains tests',
        message: `The file declares ${baseStats.tests} test(s) at base and none at head.`,
        file: change.path,
        evidence: `base declarations: ${baseStats.tests}, head declarations: 0`,
      });
    }
  }

  if (input.headInventory.testCount < input.baseInventory.testCount && deleted.length === 0) {
    add({
      rule: 'test_count_decreased',
      severity: 'soft',
      title: 'Test declaration count decreased',
      message: `Detected test declarations fell from ${input.baseInventory.testCount} to ${input.headInventory.testCount}.`,
    });
  }

  if (
    input.headInventory.assertionCount < input.baseInventory.assertionCount &&
    input.headInventory.testCount <= input.baseInventory.testCount
  ) {
    add({
      rule: 'assertions_reduced',
      severity: 'soft',
      title: 'Assertions were removed without new tests',
      message: `Assertion count fell from ${input.baseInventory.assertionCount} to ${input.headInventory.assertionCount} while the test count did not grow.`,
    });
  }
}

function checkTestMarkers(input: ForensicsInput, add: (finding: Finding) => void): void {
  for (const change of input.changes) {
    if (!isTestFilePath(change.path)) continue;
    for (const line of change.addedLines) {
      if (SKIP_MARKER.test(line.text)) {
        add({
          rule: 'test_skip_added',
          severity: 'soft',
          title: 'A test skip marker was added',
          message: 'A test or suite was disabled with a skip marker. Skipped tests do not exercise the implementation.',
          file: change.path,
          line: line.line,
          evidence: line.text.trim(),
        });
      }
      if (FOCUS_MARKER.test(line.text)) {
        add({
          rule: 'test_focus_added',
          severity: 'soft',
          title: 'A focused test marker was added',
          message: 'A focus marker (.only) can cause the rest of the suite to be silently skipped by the runner.',
          file: change.path,
          line: line.line,
          evidence: line.text.trim(),
        });
      }
    }
  }
}

function checkWeakenedExpectations(input: ForensicsInput, add: (finding: Finding) => void): void {
  const baseFailed = input.baseChecks.some((check) => check.base?.status === 'failed');
  const reproductionBaseFailed = input.reproductions.some(
    (reproduction) => reproduction.base?.status === 'failed',
  );
  if (!baseFailed && !reproductionBaseFailed) {
    return;
  }

  const noNewTests = input.headInventory.testCount <= input.baseInventory.testCount;
  if (!noNewTests) {
    return;
  }

  for (const change of input.changes) {
    if (!isTestFilePath(change.path)) continue;
    const removedAssertion = change.removedLines.find((line) => ASSERTION_LINE.test(line.text));
    const addedAssertion = change.addedLines.find((line) => ASSERTION_LINE.test(line.text));
    if (!removedAssertion && !addedAssertion) continue;
    const evidence = removedAssertion
      ? `- ${removedAssertion.text.trim()}\n+ ${addedAssertion?.text.trim() ?? '(removed)'}`
      : addedAssertion
        ? `+ ${addedAssertion.text.trim()}`
        : undefined;
    add({
      rule: 'tests_weakened_to_pass',
      severity: 'hard',
      title: 'Test expectations changed while a failing baseline turned green',
      message: 'The failing baseline is now green, tests changed, and no new tests were added. The pass may describe the new expectation rather than a fixed implementation.',
      file: change.path,
      line: removedAssertion?.line ?? addedAssertion?.line,
      evidence,
    });
  }
}

function checkTestCommands(input: ForensicsInput, add: (finding: Finding) => void): void {
  const baseScript = input.baseManifest?.scripts?.test;
  const headScript = input.headManifest?.scripts?.test;
  if (baseScript !== undefined && baseScript.trim() !== '') {
    if (headScript === undefined || headScript.trim() === '' || DISABLED_COMMAND.test(headScript.trim())) {
      add({
        rule: 'test_script_disabled',
        severity: 'hard',
        title: 'Package test script was disabled',
        message: 'package.json no longer defines a real test command.',
        file: 'package.json',
        evidence: `base: ${baseScript}\nhead: ${headScript ?? '(missing)'}`,
      });
    } else if (headScript !== baseScript) {
      add({
        rule: 'test_script_modified',
        severity: 'soft',
        title: 'Package test script was changed',
        message: 'The npm test command changed. Confirm that the new command still runs the full suite.',
        file: 'package.json',
        evidence: `base: ${baseScript}\nhead: ${headScript}`,
      });
    }
  }

  for (const check of input.headChecks) {
    const summary = check.head?.summary;
    if (!summary?.detected) continue;
    const baseSummary = check.base?.summary;
    const baselineHadTests =
      (baseSummary?.total ?? 0) > 0 ||
      input.baseInventory.testCount > 0;
    if (!baselineHadTests) continue;

    if (summary.zeroTests && check.required) {
      add({
        rule: 'zero_tests_executed',
        severity: 'hard',
        title: 'No tests were executed',
        message: `Check "${check.id}" found no tests even though the base revision contains tests. A green run with zero tests proves nothing.`,
        evidence: check.command,
      });
    }
    if (summary.allSkipped && check.required) {
      add({
        rule: 'all_tests_skipped',
        severity: 'hard',
        title: 'All detected tests were skipped',
        message: `Check "${check.id}" skipped every test it found. The suite exited successfully without exercising the code.`,
        evidence: check.command,
      });
    }
  }

  const testCountDropped = input.headInventory.testCount < input.baseInventory.testCount;
  if (testCountDropped) {
    for (const check of input.headChecks) {
      if (check.head?.status !== 'passed') continue;
      const baseSummary = check.base?.summary;
      if (baseSummary?.detected && baseSummary.total > (check.head.summary.total ?? 0)) {
        add({
          rule: 'executed_test_count_dropped',
          severity: 'hard',
          title: 'Fewer tests ran than on the baseline',
          message: `Check "${check.id}" executed ${check.head.summary.total} test(s) at head versus ${baseSummary.total} at base.`,
          evidence: check.command,
        });
      }
    }
  }
}

function checkTestConfigAndCi(input: ForensicsInput, add: (finding: Finding) => void): void {
  for (const change of input.changes) {
    if (isTestConfigFile(change.path)) {
      for (const line of change.addedLines) {
        if (TEST_CONFIG_WEAKENING.test(line.text)) {
          add({
            rule: 'test_config_weakened',
            severity: 'soft',
            title: 'Test or coverage configuration was weakened',
            message: 'A test runner or coverage setting that can exclude tests or lower enforcement was added.',
            file: change.path,
            line: line.line,
            evidence: line.text.trim(),
          });
        }
      }
    }

    if (isCiFile(change.path)) {
      const addedTestStep = change.addedLines.some((line) => TEST_INVOCATION.test(line.text));
      const removedTestStep = change.removedLines.some((line) => TEST_INVOCATION.test(line.text));
      const bypass = change.addedLines.find((line) => CI_BYPASS.test(line.text));
      if (bypass) {
        add({
          rule: 'ci_test_bypass',
          severity: 'soft',
          title: 'CI test failure can be ignored',
          message: 'The workflow change can allow failing tests or commands to succeed.',
          file: change.path,
          line: bypass.line,
          evidence: bypass.text.trim(),
        });
      }
      if (removedTestStep && !addedTestStep) {
        add({
          rule: 'ci_test_step_removed',
          severity: 'soft',
          title: 'A CI test step was removed',
          message: 'A workflow no longer invokes the test suite.',
          file: change.path,
        });
      }
      if (change.status === 'D') {
        add({
          rule: 'ci_workflow_deleted',
          severity: 'soft',
          title: 'CI workflow was deleted',
          message: 'Deleting a workflow removes an independent execution path for this change.',
          file: change.path,
        });
      }
    }
  }
}

function checkDependencies(input: ForensicsInput, add: (finding: Finding) => void): void {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const;
  const lockfileChanges = input.changes.filter((change) => isLockfile(change.path));
  if (lockfileChanges.length > 0) {
    const baseDeps = dependencySections.map((section) => canonicalJson(input.baseManifest?.[section] ?? {}));
    const headDeps = dependencySections.map((section) => canonicalJson(input.headManifest?.[section] ?? {}));
    const manifestsDiffer = baseDeps.some((value, index) => value !== headDeps[index]);
    if (!manifestsDiffer) {
      add({
        rule: 'lockfile_drift',
        severity: 'soft',
        title: 'Lockfile changed without a manifest change',
        message: 'Dependency resolution changed while package.json dependency declarations did not. Review the install surface.',
        file: lockfileChanges[0]?.path,
      });
    }
  }

  for (const scriptName of INSTALL_SCRIPTS) {
    const baseScript = input.baseManifest?.scripts?.[scriptName];
    const headScript = input.headManifest?.scripts?.[scriptName];
    if (headScript && headScript !== baseScript) {
      add({
        rule: 'install_script_added',
        severity: 'soft',
        title: 'An install lifecycle script changed',
        message: `The "${scriptName}" script can run arbitrary code during dependency installation. Skeptic disables install scripts by default.`,
        file: 'package.json',
        evidence: `${scriptName}: ${headScript}`,
      });
    }
  }
}

function checkProtectedPaths(input: ForensicsInput, add: (finding: Finding) => void): void {
  for (const change of input.changes) {
    if (!isProtectedPath(change.path, input.baseConfig.protected)) continue;
    if (isTestFilePath(change.path) || isCiFile(change.path) || isLockfile(change.path) || isTestConfigFile(change.path)) {
      continue;
    }
    add({
      rule: 'protected_file_modified',
      severity: 'soft',
      title: 'Protected file was modified',
      message: 'This path is listed as protected in the trusted verification config.',
      file: change.path,
    });
  }
}

export function runForensics(input: ForensicsInput): Finding[] {
  const { findings, add } = createFindingCollector();
  checkConfigChanges(input, add);
  checkTestFiles(input, add);
  checkTestMarkers(input, add);
  checkWeakenedExpectations(input, add);
  checkTestCommands(input, add);
  checkTestConfigAndCi(input, add);
  checkDependencies(input, add);
  checkProtectedPaths(input, add);
  return findings;
}

export function countSeverities(findings: Finding[]): { hardCount: number; softCount: number } {
  return {
    hardCount: findings.filter((finding) => finding.severity === 'hard').length,
    softCount: findings.filter((finding) => finding.severity === 'soft').length,
  };
}
