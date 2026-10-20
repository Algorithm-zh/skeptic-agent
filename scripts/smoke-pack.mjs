import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath;

async function run(command, args, options = {}) {
  const base = {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  };
  if (command === npm && npmCli) {
    return execFileAsync(process.execPath, [npmCli, ...args], { ...base, ...options });
  }
  return execFileAsync(command, args, {
    ...base,
    shell: command === npm,
    ...options,
  });
}

const packResult = await run(npm, ['pack', '--json']);
const packed = JSON.parse(packResult.stdout)[0];
if (!packed?.filename) {
  throw new Error('npm pack did not return a filename.');
}
const tarball = path.join(projectRoot, packed.filename);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'skeptic-pack-'));

try {
  await writeFile(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'skeptic-pack-smoke', private: true }, null, 2),
    'utf8',
  );
  await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: tempRoot,
  });

  const cli = path.join(tempRoot, 'node_modules', 'skeptic-agent', 'dist', 'cli.js');
  const version = await run(process.execPath, [cli, '--version'], { cwd: tempRoot });
  if (version.stdout.trim() !== '0.1.0') {
    throw new Error(`Unexpected version output: ${version.stdout.trim()}`);
  }

  const demo = await run(process.execPath, [cli, 'demo'], {
    cwd: tempRoot,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!demo.stdout.includes('4/4 verdicts matched expectations')) {
    throw new Error(`Packaged demo did not match expectations:\n${demo.stdout}`);
  }

  process.stdout.write(
    `Pack smoke test passed: ${packed.filename} (${packed.size} bytes), version ${version.stdout.trim()}, demo 4/4.\n`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  await rm(tarball, { force: true });
}
