import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: projectRoot,
    reject: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

describe('CLI surface', () => {
  it('prints the version', async () => {
    const result = await cli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('lists every command', async () => {
    const result = await cli(['--help']);
    expect(result.exitCode).toBe(0);
    for (const command of ['init', 'verify', 'demo', 'report', 'doctor']) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain('Evidence, not claims.');
  });

  it('documents verification options', async () => {
    const result = await cli(['verify', '--help']);
    expect(result.exitCode).toBe(0);
    for (const option of ['--base', '--head', '--claims', '--no-llm', '--fail-on', '--json', '--markdown']) {
      expect(result.stdout).toContain(option);
    }
  });
});
