import { Command, Option } from 'commander';
import pc from 'picocolors';
import { SkepticError } from './errors';
import { VERSION } from './version';
import { runInit } from './commands/init';
import { runVerifyCommand } from './commands/verify';
import { runDemoCommand } from './commands/demo';
import { runReportCommand } from './commands/report';
import { runDoctorCommand } from './commands/doctor';
import type { FailOnMode } from './types';

const program = new Command();

program
  .name('skeptic')
  .description('Independent verification for AI-written code. Evidence, not claims.')
  .version(VERSION, '-v, --version', 'print the Skeptic version')
  .showHelpAfterError();

program
  .command('init')
  .description('create a skeptic.yml verification contract')
  .argument('[path]', 'repository path', '.')
  .option('--force', 'overwrite an existing skeptic.yml')
  .action(async (repoPath: string, options: { force?: boolean }) => {
    process.exitCode = await runInit({ repoPath, force: options.force });
  });

program
  .command('verify')
  .description('verify a change in an isolated snapshot and write an evidence receipt')
  .argument('[path]', 'repository path', '.')
  .option('--base <ref>', 'base git ref (default: HEAD)')
  .option('--head <ref>', 'head git ref (default: working tree)')
  .option('--claims <text>', 'completion claims made by the agent')
  .option('--claims-file <path>', 'read completion claims from a file')
  .option('--config <path>', 'explicit verification config (trusted override)')
  .option('--trust-config', 'trust an uncommitted skeptic.yml')
  .option('--allow-scripts', 'allow npm install lifecycle scripts')
  .option('--llm', 'use the configured LLM to extract claims (advisory only)')
  .option('--no-llm', 'disable LLM claim extraction')
  .option('--keep-worktrees', 'keep the isolated base/head snapshots')
  .option('--quiet', 'suppress progress messages')
  .option('--json', 'print the receipt as JSON')
  .option('--markdown', 'print the Markdown report')
  .addOption(
    new Option('--fail-on <mode>', 'exit non-zero threshold')
      .choices(['warnings', 'unverified', 'never'])
      .default('unverified'),
  )
  .action(
    async (
      repoPath: string,
      options: {
        base?: string;
        head?: string;
        claims?: string;
        claimsFile?: string;
        config?: string;
        trustConfig?: boolean;
        allowScripts?: boolean;
        llm?: boolean;
        keepWorktrees?: boolean;
        quiet?: boolean;
        json?: boolean;
        markdown?: boolean;
        failOn: FailOnMode;
      },
    ) => {
      process.exitCode = await runVerifyCommand({
        repoPath,
        base: options.base,
        head: options.head,
        claims: options.claims,
        claimsFile: options.claimsFile,
        config: options.config,
        trustConfig: options.trustConfig,
        allowScripts: options.allowScripts,
        llm: options.llm,
        failOn: options.failOn,
        keepWorktrees: options.keepWorktrees,
        quiet: options.quiet,
        json: options.json,
        markdown: options.markdown,
      });
    },
  );

program
  .command('demo')
  .description('run four self-contained verification scenarios without an API key')
  .option('--keep', 'keep the generated demo repositories')
  .action(async (options: { keep?: boolean }) => {
    process.exitCode = await runDemoCommand({ keep: options.keep });
  });

program
  .command('report')
  .description('render a saved receipt as Markdown')
  .argument('[receipt]', 'receipt file or run directory (default: latest run)')
  .argument('[path]', 'repository path', '.')
  .action(async (receipt: string | undefined, repoPath: string) => {
    process.exitCode = await runReportCommand({ file: receipt, repoPath });
  });

program
  .command('doctor')
  .description('check the local environment and verification setup')
  .argument('[path]', 'repository path', '.')
  .action(async (repoPath: string) => {
    process.exitCode = await runDoctorCommand({ repoPath });
  });

function printError(error: unknown): void {
  if (error instanceof SkepticError) {
    process.stderr.write(`${pc.red('error')} ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`${pc.dim('hint')}  ${error.hint}\n`);
    }
    return;
  }
  process.stderr.write(`${pc.red('error')} ${(error as Error).message}\n`);
  if (process.env.SKEPTIC_DEBUG) {
    process.stderr.write(`${(error as Error).stack ?? ''}\n`);
  }
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
