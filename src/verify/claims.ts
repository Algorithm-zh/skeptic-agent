import type { SkepticConfig } from '../config/schema';
import { extractClaimsWithLlm } from '../llm/claims';
import type { CheckResult, Claim, Finding, ReproductionResult } from '../types';

const TESTS_PASS_PATTERNS: RegExp[] = [
  /\b(?:all\s+)?(?:unit|integration|end-to-end|e2e|the)?\s*tests?\s+(?:now\s+)?(?:pass(?:es|ed)?|are\s+passing|is\s+passing|succeed(?:s|ed)?)\b/i,
  /\b(?:all\s+)?checks?\s+(?:now\s+)?pass(?:es|ed)?\b/i,
  /\b(?:test\s+suite|the\s+suite)\s+(?:is\s+)?green\b/i,
  /\b(?:tests?|suite)\s+(?:are|is)\s+green\b/i,
  /\b(?:npm\s+test|pytest|vitest|jest)\s+(?:passes|succeeds|is\s+green)\b/i,
];

const BUG_FIX_PATTERN =
  /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|address(?:es|ed)?)\s*:?\s*(?:issue\s+|bug\s+)?#(\d{1,9})\b/i;
const BUG_FIX_GENERIC =
  /\b(?:fix(?:es|ed)?|resolv(?:e[sd]?|ing)|address(?:es|ed)?)\s+(?:the\s+)?(?:bug|issue|problem|regression)\b/i;

const INTEGRITY_RULES = new Set([
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
]);

function splitClaimText(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean);
}

export function extractHeuristicClaims(text: string | undefined): Claim[] {
  if (!text || !text.trim()) {
    return [];
  }
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const push = (claim: Claim) => {
    const key = `${claim.type}:${claim.text.toLowerCase().replace(/\s+/g, ' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(claim);
  };

  for (const sentence of splitClaimText(text).slice(0, 20)) {
    const trimmed = sentence.slice(0, 500);
    if (TESTS_PASS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      push({
        text: trimmed,
        type: 'tests_pass',
        source: 'heuristic',
        status: 'informational',
        material: true,
        evidence: [],
      });
    }
    const issueMatch = trimmed.match(BUG_FIX_PATTERN);
    if (issueMatch || BUG_FIX_GENERIC.test(trimmed)) {
      push({
        text: trimmed,
        type: 'bug_fixed',
        issue: issueMatch ? Number(issueMatch[1]) : undefined,
        source: 'heuristic',
        status: 'informational',
        material: true,
        evidence: [],
      });
    }
  }
  return claims;
}

export interface CollectClaimsOptions {
  text?: string;
  llmEnabled: boolean;
  llmConfig: SkepticConfig['llm'];
  checkIds: string[];
  onProgress?: (message: string) => void;
}

export async function collectClaims(options: CollectClaimsOptions): Promise<Claim[]> {
  const claims = extractHeuristicClaims(options.text);
  if (!options.llmEnabled || !options.text?.trim()) {
    return claims;
  }

  const apiKey = process.env[options.llmConfig.apiKeyEnv];
  if (!apiKey) {
    options.onProgress?.(
      `LLM claim extraction skipped: ${options.llmConfig.apiKeyEnv} is not set. Heuristics were used.`,
    );
    return claims;
  }

  try {
    options.onProgress?.('Extracting claims with the configured LLM (advisory only)...');
    const llmClaims = await extractClaimsWithLlm(
      options.text,
      options.llmConfig,
      options.checkIds,
    );
    const known = new Set(
      claims.map((claim) => `${claim.type}:${claim.text.toLowerCase().replace(/\s+/g, ' ')}`),
    );
    for (const claim of llmClaims) {
      const key = `${claim.type}:${claim.text.toLowerCase().replace(/\s+/g, ' ')}`;
      if (!known.has(key)) {
        known.add(key);
        claims.push(claim);
      }
    }
  } catch (error) {
    options.onProgress?.(
      `LLM claim extraction failed and was skipped: ${(error as Error).message}`,
    );
  }
  return claims;
}

export interface ClaimEvaluationContext {
  checks: CheckResult[];
  reproductions: ReproductionResult[];
  findings: Finding[];
}

function summarizeCheck(check: CheckResult): string {
  const summary = check.head?.summary;
  if (!summary?.detected) {
    return check.head?.status === 'passed' ? 'passed (no test output detected)' : `not passed (${check.head?.status ?? 'not run'})`;
  }
  return `${check.head?.status ?? 'not run'}, ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`;
}

function evaluateTestsPass(claim: Claim, context: ClaimEvaluationContext): Claim {
  const relevant = claim.checkId
    ? context.checks.filter((check) => check.id === claim.checkId)
    : context.checks.filter((check) => check.required);
  const checks = relevant.length > 0 ? relevant : context.checks;

  if (claim.checkId && relevant.length === 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: [],
      rationale: `The claim references check "${claim.checkId}", which does not exist.`,
    };
  }
  if (checks.length === 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: [],
      rationale: 'No verification check is available to support this claim.',
    };
  }

  const failed = checks.filter((check) => check.head?.status === 'failed');
  if (failed.length > 0) {
    const regression = failed.some((check) => check.attribution === 'regression');
    const preExisting = failed.filter((check) => check.attribution === 'pre_existing_failure');
    return {
      ...claim,
      status: regression ? 'contradicted' : 'unsupported',
      evidence: failed.map((check) => `check:${check.id} (failed)`),
      rationale: regression
        ? 'A required check failed at head while passing at base.'
        : preExisting.length > 0
          ? 'A required check failed at head; the same check also failed at base, so the failure is pre-existing rather than caused by this change.'
          : 'A required check did not produce a passing result at head.',
    };
  }

  const unresolved = checks.filter((check) => check.head?.status !== 'passed');
  if (unresolved.length > 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: unresolved.map((check) => `check:${check.id} (${check.head?.status ?? 'not run'})`),
      rationale: 'A required check could not be executed to completion.',
    };
  }

  const integrityFindings = context.findings.filter(
    (finding) => finding.severity === 'hard' && INTEGRITY_RULES.has(finding.rule),
  );
  if (integrityFindings.length > 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: integrityFindings.map((finding) => `forensics:${finding.rule}`),
      rationale: `Test integrity findings undermine a claim that everything passes: ${integrityFindings
        .map((finding) => finding.title)
        .join('; ')}.`,
    };
  }

  const summaries = checks.map((check) => check.head?.summary).filter((summary) => summary?.detected);
  const treatedAsNoTests = summaries.some((summary) => summary?.zeroTests || summary?.allSkipped);
  if (summaries.length === 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: checks.map((check) => `check:${check.id} (passed)`),
      rationale: 'Checks passed, but no executed test results were detected in their output.',
    };
  }
  if (treatedAsNoTests) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: checks.map((check) => `check:${check.id}`),
      rationale: 'The suite reported zero executed tests or skipped every test it found.',
    };
  }

  return {
    ...claim,
    status: 'supported',
    evidence: checks.map((check) => `check:${check.id} (${summarizeCheck(check)})`),
    rationale: 'Every required check passed and the check output contains executed test results.',
  };
}

function reproductionMatches(claim: Claim, reproduction: ReproductionResult): boolean {
  if (claim.issue !== undefined) {
    const pattern = new RegExp(`(?:^|[^0-9])#?${claim.issue}(?:[^0-9]|$)`);
    return pattern.test(`${reproduction.id} ${reproduction.name} ${reproduction.command}`);
  }
  return claim.text.toLowerCase().includes(reproduction.id.toLowerCase());
}

function evaluateBugFixed(claim: Claim, context: ClaimEvaluationContext): Claim {
  const matching = context.reproductions.filter((reproduction) =>
    reproductionMatches(claim, reproduction),
  );
  if (matching.length === 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: [],
      rationale: claim.issue
        ? `No configured reproduction covers issue #${claim.issue}. A passing test suite alone does not prove this bug was present and is now fixed.`
        : 'No configured reproduction is available to prove that the bug existed before the change and is gone after it.',
    };
  }

  const proven = matching.filter((reproduction) => reproduction.status === 'proven');
  if (proven.length > 0) {
    return {
      ...claim,
      status: 'supported',
      evidence: proven.map((reproduction) => `reproduction:${reproduction.id} (proven)`),
      rationale: 'A configured reproduction failed at base and passed at head.',
    };
  }

  const tainted = matching.filter((reproduction) => reproduction.status === 'tainted');
  if (tainted.length > 0) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: tainted.map((reproduction) => `reproduction:${reproduction.id} (tainted)`),
      rationale: tainted[0]?.taint ?? 'The proof was tainted by changes to the tests it depends on.',
    };
  }

  const failedAtHead = matching.find(
    (reproduction) => reproduction.head?.status === 'failed',
  );
  if (failedAtHead) {
    return {
      ...claim,
      status: 'contradicted',
      evidence: failedAtHead.base?.status === 'failed'
        ? [
            `reproduction:${failedAtHead.id} (failed at base)`,
            `reproduction:${failedAtHead.id} (failed at head)`,
          ]
        : [`reproduction:${failedAtHead.id} (failed at head)`],
      rationale: 'The configured reproduction still fails at head.',
    };
  }

  const basePassed = matching.find((reproduction) => reproduction.base?.status === 'passed');
  if (basePassed) {
    return {
      ...claim,
      status: 'unsupported',
      evidence: [`reproduction:${basePassed.id} (passed at base)`],
      rationale: 'The reproduction did not fail before the change, so it cannot prove a fix.',
    };
  }

  return {
    ...claim,
    status: 'unsupported',
    evidence: matching.map((reproduction) => `reproduction:${reproduction.id} (${reproduction.status})`),
    rationale: 'The configured reproduction did not produce conclusive evidence.',
  };
}

export function evaluateClaims(
  claims: Claim[],
  context: ClaimEvaluationContext,
): Claim[] {
  return claims.map((claim) => {
    if (claim.type === 'tests_pass') {
      return evaluateTestsPass(claim, context);
    }
    if (claim.type === 'bug_fixed') {
      return evaluateBugFixed(claim, context);
    }
    return { ...claim, status: 'informational', material: false };
  });
}
