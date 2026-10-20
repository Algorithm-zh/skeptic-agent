import pc from 'picocolors';
import type { Receipt, VerdictLevel } from '../types';

const VERDICT_LABEL: Record<VerdictLevel, string> = {
  verified: 'VERIFIED',
  verified_with_warnings: 'VERIFIED WITH WARNINGS',
  unverified: 'UNVERIFIED',
  failed: 'FAILED',
};

function paintVerdict(level: VerdictLevel, text: string): string {
  if (level === 'verified') return pc.green(pc.bold(text));
  if (level === 'verified_with_warnings') return pc.yellow(pc.bold(text));
  if (level === 'unverified') return pc.yellow(pc.bold(text));
  return pc.red(pc.bold(text));
}

function paintStatus(status: string): string {
  if (status === 'passed' || status === 'proven' || status === 'supported') return pc.green(status);
  if (status === 'failed' || status === 'contradicted' || status === 'tainted') return pc.red(status);
  if (status === 'error' || status === 'not_run' || status === 'inconclusive') return pc.yellow(status);
  return pc.dim(status);
}

export function renderConsole(receipt: Receipt): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${pc.bold('SKEPTIC')} ${pc.dim(`v${receipt.tool.version}`)}  ${pc.dim('Your agent says done. Skeptic checks.')}`);
  lines.push('');
  lines.push(paintVerdict(receipt.verdict.level, VERDICT_LABEL[receipt.verdict.level]));
  for (const reason of receipt.verdict.reasons.slice(0, 4)) {
    lines.push(`  ${pc.dim('-')} ${reason}`);
  }
  lines.push('');

  if (receipt.checks.length > 0) {
    lines.push(pc.bold('Checks'));
    for (const check of receipt.checks) {
      const status = check.head?.status ?? 'not_run';
      const summary = check.head?.summary;
      const detail = summary?.detected
        ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
        : '';
      lines.push(
        `  ${paintStatus(status).padEnd(18)} ${check.id}${check.required ? '' : pc.dim(' (optional)')}${detail ? pc.dim(`  ${detail}`) : ''}`,
      );
    }
    lines.push('');
  }

  const findings = receipt.forensics.findings;
  if (findings.length > 0) {
    lines.push(pc.bold('Findings'));
    const shown = findings.filter((finding) => finding.severity !== 'info').slice(0, 6);
    for (const finding of shown) {
      const tag = finding.severity === 'hard' ? pc.red('HARD') : pc.yellow('SOFT');
      const location = finding.file ? pc.dim(` (${finding.file}${finding.line ? `:${finding.line}` : ''})`) : '';
      lines.push(`  ${tag} ${finding.title}${location}`);
    }
    if (findings.length > shown.length) {
      lines.push(pc.dim(`  ...and ${findings.length - shown.length} more in the report`));
    }
    lines.push('');
  }

  const shownClaims = receipt.claims.filter((claim) => claim.material).slice(0, 4);
  if (shownClaims.length > 0) {
    lines.push(pc.bold('Claims'));
    for (const claim of shownClaims) {
      lines.push(
        `  ${paintStatus(claim.status).padEnd(18)} ${pc.dim(`"${claim.text.slice(0, 80)}${claim.text.length > 80 ? '...' : ''}"`)}`,
      );
    }
    lines.push('');
  }

  lines.push(pc.bold('Evidence'));
  lines.push(`  ${pc.dim('receipt')}  ${receipt.artifacts.receiptPath}`);
  lines.push(`  ${pc.dim('report ')}  ${receipt.artifacts.reportPath}`);
  lines.push(`  ${pc.dim('hash   ')}  ${receipt.receiptSha256.slice(0, 16)}...`);
  lines.push('');
  return lines.join('\n');
}
