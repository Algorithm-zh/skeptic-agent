import type { CheckResult, Claim, Finding, ReproductionResult, VerdictInfo, VerdictLevel } from '../types';

export interface VerdictInput {
  checks: CheckResult[];
  reproductions: ReproductionResult[];
  findings: Finding[];
  claims: Claim[];
}

function uniqReasons(reasons: string[]): string[] {
  return [...new Set(reasons.filter(Boolean))].slice(0, 6);
}

function findingReason(finding: Finding): string {
  const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
  return `${finding.title}${location}`;
}

export function computeVerdict(input: VerdictInput): VerdictInfo {
  const reasons: string[] = [];

  for (const check of input.checks) {
    if (!check.required) continue;
    const head = check.head;
    if (!head || head.status === 'passed') continue;
    if (head.status === 'error') {
      return {
        level: 'unverified',
        reasons: uniqReasons([
          `Required check "${check.id}" did not complete (${head.timedOut ? 'timed out' : 'execution error'}).`,
        ]),
      };
    }
    if (check.attribution === 'regression') {
      return {
        level: 'failed',
        reasons: uniqReasons([
          `Required check "${check.id}" failed at head but passed at base.`,
        ]),
      };
    }
    if (check.attribution === 'pre_existing_failure') {
      return {
        level: 'unverified',
        reasons: uniqReasons([
          `Required check "${check.id}" failed, and the same check also failed at base. The failure is pre-existing, so this change is not proven either way.`,
        ]),
      };
    }
    return {
      level: 'unverified',
      reasons: uniqReasons([
        `Required check "${check.id}" failed at head and the baseline could not be evaluated.`,
      ]),
    };
  }

  for (const reproduction of input.reproductions) {
    if (reproduction.status === 'tainted') {
      return {
        level: 'unverified',
        reasons: uniqReasons([
          `Reproduction "${reproduction.id}" was tainted: ${reproduction.taint ?? 'its tests were modified.'}`,
        ]),
      };
    }
    if (reproduction.status === 'not_proven') {
      if (reproduction.base?.status === 'failed' && reproduction.head?.status === 'failed') {
        return {
          level: 'failed',
          reasons: uniqReasons([
            `Configured reproduction "${reproduction.id}" still fails at head after failing at base.`,
          ]),
        };
      }
      return {
        level: 'unverified',
        reasons: uniqReasons([
          `Configured reproduction "${reproduction.id}" did not demonstrate a failing baseline followed by a pass.`,
        ]),
      };
    }
    if (reproduction.status === 'inconclusive') {
      return {
        level: 'unverified',
        reasons: uniqReasons([
          `Configured reproduction "${reproduction.id}" was inconclusive.`,
        ]),
      };
    }
  }

  const hardFindings = input.findings.filter((finding) => finding.severity === 'hard');
  if (hardFindings.length > 0) {
    return {
      level: 'unverified',
      reasons: uniqReasons(hardFindings.map(findingReason)),
    };
  }

  const deterministicClaims = input.claims.filter((claim) => claim.source !== 'llm');
  const contradicted = deterministicClaims.filter(
    (claim) => claim.material && claim.status === 'contradicted',
  );
  if (contradicted.length > 0) {
    return {
      level: 'failed',
      reasons: uniqReasons(contradicted.map((claim) => `Claim contradicted by evidence: "${claim.text}"`)),
    };
  }

  const unsupported = deterministicClaims.filter(
    (claim) => claim.material && claim.status === 'unsupported',
  );
  if (unsupported.length > 0) {
    return {
      level: 'unverified',
      reasons: uniqReasons(unsupported.map((claim) => `Claim lacks evidence: "${claim.text}"`)),
    };
  }

  const softFindings = input.findings.filter((finding) => finding.severity === 'soft');
  if (softFindings.length > 0) {
    reasons.push(...softFindings.map(findingReason));
    return { level: 'verified_with_warnings', reasons: uniqReasons(reasons) };
  }

  reasons.push('All required checks passed.');
  const supported = deterministicClaims.filter((claim) => claim.material);
  if (supported.length > 0) {
    reasons.push('Every material claim is backed by evidence.');
  }
  return { level: 'verified', reasons: uniqReasons(reasons) };
}

export function exitCodeForVerdict(level: VerdictLevel, failOn: 'warnings' | 'unverified' | 'never'): number {
  if (failOn === 'never') return 0;
  if (level === 'failed') return 1;
  if (level === 'unverified') return 1;
  if (level === 'verified_with_warnings') {
    return failOn === 'warnings' ? 1 : 0;
  }
  return 0;
}
