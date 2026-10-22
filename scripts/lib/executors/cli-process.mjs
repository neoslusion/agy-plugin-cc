import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { runCommand, binaryAvailable } from '../process.mjs';

export function terminateProcess(pid) {
  if (!pid) throw new Error('job has no pid to cancel');
  if (process.platform === 'win32') {
    if (runCommand('taskkill', ['/pid', String(pid), '/T', '/F']).code === 0) return;
  } else {
    try { process.kill(-pid, 'SIGKILL'); return; } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  try { process.kill(pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}

export function cliPreflight(binary, { cwd } = {}) {
  if (!binaryAvailable(binary)) return { ready: false, binary: false, auth: null, version: null, hint: `Install ${binary} and authenticate interactively.` };
  const probe = runCommand(binary, ['--version'], { cwd, timeoutMs: 10_000 });
  return { ready: probe.code === 0, binary: true, auth: null, version: probe.stdout.trim() || null, hint: `Credentials are checked by ${binary} when a task runs. Authenticate with the CLI first.` };
}

export function runCli({ binary, args, prompt, cwd, env = process.env, timeoutMs = 30 * 60 * 1000, onEvent, onProgress = () => {}, onStdoutLine, onStderrLine }) {
  return new Promise((resolve, reject) => {
    const script = /\.(mjs|cjs|js)$/i.test(binary);
    const child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let pending = '', stderr = '', timedOut = false, protocolError = null;
    const decoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const kill = () => { try { terminateProcess(child.pid); } catch {} };
    const handleLine = (line) => {
      if (!line.trim()) return;
      try { onEvent(JSON.parse(line)); }
      catch (err) { protocolError = `Invalid ${binary} event stream: ${err.message}`; kill(); }
    };
    const onSignal = () => kill();
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    };
    child.on('spawn', () => onProgress({ type: 'spawn', pid: child.pid, binary }));
    child.stdout.on('data', chunk => {
      const text = decoder.write(chunk);
      onStdoutLine?.(text);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) handleLine(line);
      if (pending.length > 16 * 1024 * 1024) { protocolError = 'Event exceeded 16 MiB'; kill(); }
    });
    child.stderr.on('data', chunk => {
      const text = errDecoder.write(chunk);
      stderr = (stderr + text).slice(-64 * 1024);
      onStderrLine?.(text);
    });
    child.stdin.on('error', () => {}); // Early CLI failures can close stdin before the prompt finishes writing.
    child.on('error', err => { cleanup(); reject(err); });
    child.on('close', code => {
      cleanup();
      pending += decoder.end();
      if (pending.trim()) handleLine(pending);
      resolve({ exitCode: code, stderr: stderr + errDecoder.end(), error: timedOut ? `Executor timed out after ${timeoutMs}ms` : protocolError });
    });
    child.stdin.end(prompt);
  });
}
