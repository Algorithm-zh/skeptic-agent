import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripAnsi } from '../util/ansi';
import { sha256 } from '../util/hash';
import { parseTestSummary } from './test-summary';
import { killProcessTree } from './process-tree';
import type { CheckRunStatus, RunResult } from '../types';

export interface RunCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  logPath: string;
  logRef: string;
  label: string;
}

const MAX_LOG_CHARS = 10 * 1024 * 1024;

function truncateLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) {
    return value;
  }
  const half = Math.floor(MAX_LOG_CHARS / 2);
  return `${value.slice(0, half)}\n\n[... output truncated ...]\n\n${value.slice(-half)}`;
}

function excerpt(value: string): string {
  const clean = stripAnsi(value).trim();
  if (clean.length <= 3000) {
    return clean;
  }
  return `${clean.slice(0, 1200)}\n\n[...]\n\n${clean.slice(-1800)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function runCommand(options: RunCommandOptions): Promise<RunResult> {
  const startedAt = Date.now();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const child = execa(options.command, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
    reject: false,
    stdin: 'ignore',
    stripFinalNewline: false,
    maxBuffer: 50 * 1024 * 1024,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        void killProcessTree(child.pid);
      }
    }, options.timeoutMs);
  }

  const awaitChild = (async () => {
    try {
      return await child;
    } catch (error) {
      return error as { stdout?: string; stderr?: string; exitCode?: number | null };
    }
  })();

  const result = timedOut
    ? await Promise.race([awaitChild, delay(5000).then(() => undefined)])
    : await awaitChild;

  if (timer) {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const exitCode =
    typeof result?.exitCode === 'number' ? result.exitCode : result?.exitCode === null ? null : null;
  const failedToExit = result === undefined;

  let status: CheckRunStatus;
  if (timedOut || failedToExit) {
    status = 'error';
  } else if (exitCode === 0) {
    status = 'passed';
  } else if (exitCode !== null) {
    status = 'failed';
  } else {
    status = 'error';
  }

  const combined = [stdout, stderr ? `--- stderr ---\n${stderr}` : '']
    .filter(Boolean)
    .join('\n');
  const logHeader = [
    `$ ${options.command}`,
    `label: ${options.label}`,
    `cwd: ${options.cwd}`,
    `started: ${new Date(startedAt).toISOString()}`,
    `timeout: ${options.timeoutMs}ms`,
    timedOut ? 'timed_out: true' : undefined,
    failedToExit ? 'did_not_exit: true' : undefined,
    `exit_code: ${exitCode ?? 'null'}`,
    '--- output ---',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  const logContent = truncateLog(`${logHeader}\n${combined}\n`);
  await mkdir(path.dirname(options.logPath), { recursive: true });
  await writeFile(options.logPath, logContent, 'utf8');

  return {
    status,
    exitCode: timedOut ? null : exitCode,
    durationMs,
    timedOut,
    logFile: options.logRef,
    logSha256: sha256(logContent),
    outputExcerpt: excerpt(combined),
    summary: parseTestSummary(combined),
  };
}
