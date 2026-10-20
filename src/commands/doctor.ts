import path from 'node:path';
import pc from 'picocolors';
import { parseConfigText } from '../config/load';
import { getGitVersion, getRepoRoot, getWorkingStatus, readFileAtRef, readWorkingFile } from '../git/git';
import { readTextIfExists } from '../util/fs';

export interface DoctorOptions {
  repoPath: string;
}

interface CheckLine {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  detail: string;
}

function line(status: CheckLine['status'], label: string, detail: string): CheckLine {
  return { status, label, detail };
}

function paint(line: CheckLine): string {
  if (line.status === 'ok') return `${pc.green('OK  ')}  ${line.label}${line.detail ? pc.dim(`  ${line.detail}`) : ''}`;
  if (line.status === 'warn') return `${pc.yellow('WARN')}  ${line.label}${line.detail ? pc.dim(`  ${line.detail}`) : ''}`;
  return `${pc.red('FAIL')}  ${line.label}${line.detail ? pc.dim(`  ${line.detail}`) : ''}`;
}

export async function runDoctorCommand(options: DoctorOptions): Promise<number> {
  const lines: CheckLine[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  lines.push(
    nodeMajor >= 20
      ? line('ok', 'Node.js', `${process.version}`)
      : line('fail', 'Node.js', `${process.version} is too old; Node.js 20 or newer is required`),
  );

  const gitVersion = await getGitVersion();
  lines.push(
    gitVersion
      ? line('ok', 'Git', gitVersion)
      : line('fail', 'Git', 'git was not found on PATH'),
  );

  let repoRoot: string | undefined;
  try {
    repoRoot = await getRepoRoot(options.repoPath);
    lines.push(line('ok', 'Repository', repoRoot));
  } catch (error) {
    lines.push(line('fail', 'Repository', (error as Error).message));
  }

  if (repoRoot) {
    const status = await getWorkingStatus(repoRoot);
    lines.push(
      status.length > 0
        ? line('warn', 'Working tree', 'contains uncommitted changes; verify will include them unless --head is used')
        : line('ok', 'Working tree', 'clean'),
    );

    const headConfig = await readFileAtRef(repoRoot, 'HEAD', 'skeptic.yml');
    if (headConfig) {
      try {
        parseConfigText(headConfig.text, 'skeptic.yml at HEAD');
        lines.push(line('ok', 'Trusted config', 'skeptic.yml is committed and valid'));
      } catch (error) {
        lines.push(line('fail', 'Trusted config', (error as Error).message));
      }
      const workingConfig = await readWorkingFile(repoRoot, 'skeptic.yml');
      if (workingConfig && workingConfig.text !== headConfig.text) {
        lines.push(
          line('warn', 'Config drift', 'the working-tree skeptic.yml differs from HEAD; verify will flag or ignore it'),
        );
      }
    } else {
      const workingConfig = await readWorkingFile(repoRoot, 'skeptic.yml');
      lines.push(
        workingConfig
          ? line('warn', 'Trusted config', 'skeptic.yml is uncommitted; verify requires --trust-config')
          : line('warn', 'Trusted config', 'skeptic.yml is missing; run skeptic init'),
      );
    }

    const packageText = await readTextIfExists(path.join(repoRoot, 'package.json'));
    if (packageText) {
      try {
        const manifest = JSON.parse(packageText) as { scripts?: Record<string, unknown> };
        lines.push(
          typeof manifest.scripts?.test === 'string'
            ? line('ok', 'Test script', manifest.scripts.test)
            : line('warn', 'Test script', 'no npm test script found; configure a check command explicitly'),
        );
      } catch {
        lines.push(line('warn', 'package.json', 'could not be parsed'));
      }
    }
  }

  process.stdout.write(`${pc.bold('Skeptic doctor')}\n\n`);
  for (const entry of lines) {
    process.stdout.write(`  ${paint(entry)}\n`);
  }
  process.stdout.write(
    '\nOptional: set SKEPTIC_API_KEY and enable llm in skeptic.yml for advisory claim extraction.\n',
  );

  return lines.some((entry) => entry.status === 'fail') ? 1 : 0;
}
