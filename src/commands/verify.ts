import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { SkepticError } from '../errors';
import { renderConsole } from '../receipt/console';
import { verifyRepo } from '../verify/orchestrator';
import type { FailOnMode } from '../types';

export interface VerifyCommandOptions {
  repoPath: string;
  base?: string;
  head?: string;
  claims?: string;
  claimsFile?: string;
  config?: string;
  trustConfig?: boolean;
  allowScripts?: boolean;
  llm?: boolean;
  failOn?: FailOnMode;
  keepWorktrees?: boolean;
  quiet?: boolean;
  json?: boolean;
  markdown?: boolean;
}

const MAX_CLAIMS_CHARS = 8000;

async function readClaims(options: VerifyCommandOptions): Promise<string | undefined> {
  const parts: string[] = [];
  if (options.claims?.trim()) {
    parts.push(options.claims.trim());
  }
  if (options.claimsFile) {
    try {
      const fileClaims = await readFile(options.claimsFile, 'utf8');
      if (fileClaims.trim()) {
        parts.push(fileClaims.trim());
      }
    } catch (error) {
      throw new SkepticError(
        'CLAIMS_FILE_UNREADABLE',
        `Could not read claims file: ${options.claimsFile}`,
        (error as Error).message,
      );
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('\n\n').slice(0, MAX_CLAIMS_CHARS);
}

export async function runVerifyCommand(options: VerifyCommandOptions): Promise<number> {
  const claimsText = await readClaims(options);
  const outcome = await verifyRepo({
    repoPath: options.repoPath,
    base: options.base,
    head: options.head,
    claimsText,
    configPath: options.config,
    trustConfig: options.trustConfig,
    allowScripts: options.allowScripts,
    llm: options.llm,
    failOn: options.failOn ?? 'unverified',
    keepWorktrees: options.keepWorktrees,
    onProgress: options.quiet
      ? undefined
      : (message) => {
          process.stderr.write(`${pc.dim(`  ${message}`)}\n`);
        },
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome.receipt, null, 2)}\n`);
  } else if (options.markdown) {
    process.stdout.write(`${outcome.markdown}\n`);
  } else {
    process.stdout.write(renderConsole(outcome.receipt));
  }

  return outcome.exitCode;
}
