import type { CheckRunStatus, Finding, Receipt, VerdictLevel } from '../types';

const VERDICT_LABEL: Record<VerdictLevel, string> = {
  verified: 'VERIFIED',
  verified_with_warnings: 'VERIFIED WITH WARNINGS',
  unverified: 'UNVERIFIED',
  failed: 'FAILED',
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}

function codeBlock(value: string): string {
  const fence = value.includes('```') ? '````' : '```';
  return `${fence}\n${value}\n${fence}`;
}

function statusLabel(result: { status: CheckRunStatus } | undefined): string {
  if (!result) return 'not run';
  if (result.status === 'passed') return 'passed';
  if (result.status === 'failed') return 'failed';
  if (result.status === 'error') return 'error';
  return 'not run';
}

function findingSection(findings: Finding[], severity: Finding['severity']): string[] {
  const selected = findings.filter((finding) => finding.severity === severity);
  if (selected.length === 0) return [];
  const label = severity === 'hard' ? 'Hard findings' : severity === 'soft' ? 'Soft findings' : 'Notes';
  const lines = [`### ${label}`, ''];
  for (const finding of selected) {
    lines.push(`#### ${severity.toUpperCase()}: ${finding.title}`, '');
    lines.push(finding.message, '');
    if (finding.file) {
      lines.push(`Location: \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``, '');
    }
    if (finding.evidence) {
      lines.push(codeBlock(finding.evidence), '');
    }
  }
  return lines;
}

export function renderMarkdown(receipt: Receipt): string {
  const lines: string[] = [];
  const verdict = receipt.verdict;

  lines.push('# Skeptic verification report', '');
  lines.push('> Your agent says done. Skeptic checks.', '');
  lines.push(`## Verdict: ${VERDICT_LABEL[verdict.level]}`, '');
  for (const reason of verdict.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push('');

  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Verdict | **${VERDICT_LABEL[verdict.level]}** |`);
  lines.push(`| Repository | ${escapeCell(receipt.input.repository)} |`);
  lines.push(`| Base | \`${receipt.input.baseRef}\` (${receipt.input.baseSha.slice(0, 12)}) |`);
  lines.push(
    `| Head | ${receipt.input.headRef ? `\`${receipt.input.headRef}\` (${(receipt.input.headSha ?? '').slice(0, 12)})` : `working tree${receipt.input.dirty ? ' (dirty)' : ''}`} |`,
  );
  lines.push(`| Changed files | ${receipt.input.changedFiles} |`);
  lines.push(`| Diff fingerprint | \`${receipt.input.diffSha256.slice(0, 16)}\` |`);
  lines.push(
    `| Config | ${receipt.config.source}${receipt.config.trusted ? ', trusted' : ', untrusted'}${receipt.config.modified ? ', **modified at head**' : ''} |`,
  );
  lines.push(`| Tool | ${receipt.tool.name} ${receipt.tool.version} |`);
  lines.push(`| Created | ${receipt.createdAt} |`);
  lines.push('');

  lines.push('## Checks', '');
  if (receipt.checks.length === 0) {
    lines.push('No checks were recorded.', '');
  } else {
    lines.push('| Check | Required | Head | Base | Result |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const check of receipt.checks) {
      const summary = check.head?.summary;
      const result = summary?.detected
        ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
        : '';
      lines.push(
        `| ${escapeCell(check.name)} (\`${check.id}\`) | ${check.required ? 'yes' : 'no'} | ${statusLabel(check.head)} | ${statusLabel(check.base)} | ${escapeCell(result)} |`,
      );
    }
    lines.push('');
    for (const check of receipt.checks) {
      lines.push(`- \`${check.id}\`: \`${check.command}\`${check.attribution ? ` (attribution: ${check.attribution})` : ''}`);
    }
    lines.push('');
  }

  if (receipt.setup) {
    lines.push('## Setup', '');
    lines.push(`\`${receipt.setup.status}\` in ${receipt.setup.durationMs}ms`, '');
  }

  lines.push('## Reproductions', '');
  if (receipt.reproductions.length === 0) {
    lines.push('No reproduction commands were configured.', '');
  } else {
    lines.push('| Reproduction | Command | Base | Head | Status |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const reproduction of receipt.reproductions) {
      lines.push(
        `| ${escapeCell(reproduction.name)} | \`${escapeCell(reproduction.command)}\` | ${statusLabel(reproduction.base)} | ${statusLabel(reproduction.head)} | ${reproduction.status}${reproduction.taint ? `: ${escapeCell(reproduction.taint)}` : ''} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Findings', '');
  if (receipt.forensics.findings.length === 0) {
    lines.push('No integrity findings were detected.', '');
  } else {
    lines.push(
      `${receipt.forensics.hardCount} hard finding(s), ${receipt.forensics.softCount} soft finding(s).`,
      '',
    );
    lines.push(...findingSection(receipt.forensics.findings, 'hard'));
    lines.push(...findingSection(receipt.forensics.findings, 'soft'));
    lines.push(...findingSection(receipt.forensics.findings, 'info'));
  }

  lines.push('## Claims', '');
  if (receipt.claims.length === 0) {
    lines.push('No completion claims were provided or detected.', '');
  } else {
    lines.push('| Claim | Type | Status | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const claim of receipt.claims) {
      const evidence = claim.evidence.length > 0 ? claim.evidence.join('; ') : claim.rationale ?? '';
      lines.push(
        `| ${escapeCell(claim.text)}${claim.source === 'llm' ? ' _(LLM-extracted, advisory)_' : ''} | ${claim.type} | ${claim.status} | ${escapeCell(evidence)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Evidence artifacts', '');
  lines.push(`- Receipt: \`${receipt.artifacts.receiptPath}\``);
  lines.push(`- Report: \`${receipt.artifacts.reportPath}\``);
  lines.push(`- Logs: \`${receipt.artifacts.logsDir}\``);
  lines.push(`- Receipt SHA-256: \`${receipt.receiptSha256}\``);
  lines.push('');
  lines.push('Logs may contain sensitive output produced by the tested code. Review before sharing.', '');
  lines.push('The receipt hash provides integrity, not authenticity; it is not a cryptographic signature.', '');

  if (receipt.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const limitation of receipt.limitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push(
    'Verdicts are computed by deterministic rules. Optional LLM output is advisory and cannot change the verdict.',
    '',
  );
  return lines.join('\n');
}
