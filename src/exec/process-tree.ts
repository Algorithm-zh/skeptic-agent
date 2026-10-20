import { execa } from 'execa';

export async function killProcessTree(pid: number): Promise<void> {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
      reject: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
}
