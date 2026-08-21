import { spawn, spawnSync } from 'node:child_process';

export function runCommand(cmd, args = [], { cwd, env, input, timeoutMs } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    input,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ?? null,
  };
}

export function runCommandChecked(cmd, args = [], options = {}) {
  const res = runCommand(cmd, args, options);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(`command failed (${cmd}${args.length ? ' ' + args.join(' ') : ''}): exit ${res.code}${detail ? ' - ' + detail : ''}`);
  }
  return res;
}

export function binaryAvailable(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return runCommand(probe, [cmd]).code === 0;
}

export function spawnDetached(cmd, args = [], { cwd, env = process.env, logFile } = {}) {
  // stdio is fully ignored so the parent never holds the child's pipes:
  // holding them would keep the parent's event loop alive until the worker
  // exits, making "--background" block. The worker self-logs to the job log.
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    shell: false,
  });
  child.unref();
  return { child, pid: child.pid };
}
