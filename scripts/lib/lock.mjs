import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

// A lock is a file created exclusively. The holder records its pid so a
// waiter can tell a live holder apart from one that died inside the
// critical section.
const MAX_ATTEMPTS = 60;
const BASE_DELAY_MS = 5;
const MAX_DELAY_MS = 250;
const STALE_AFTER_MS = 60_000;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function holderPid(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockIdentity(path) {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

// A lock left behind by a killed process wedges every later caller, so a
// lock whose holder is gone is removed instead of waited on forever.
//
// The file may have been released and re-acquired since it was inspected, so
// the file identity is compared again immediately before removal. A lock
// whose holder cannot be identified is only broken once it is older than the
// stale window.
export function breakAbandonedLock(path) {
  const identity = lockIdentity(path);
  if (!identity) return false;
  const pid = holderPid(path);
  const abandoned = pid !== null ? alive(pid) === false : Date.now() - identity.mtimeMs >= STALE_AFTER_MS;
  if (!abandoned) return false;
  const current = lockIdentity(path);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

export function withLock(path, action) {
  for (let attempt = 0; ; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= MAX_ATTEMPTS) throw new Error(`timed out waiting for the lock ${path}`);
      // Jitter the backoff so concurrent waiters do not retry in lockstep and
      // collide again on every wake-up.
      if (!breakAbandonedLock(path)) {
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 6));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay * (0.5 + Math.random()));
      }
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
      return action();
    } finally {
      try { closeSync(fd); } catch {}
      try { unlinkSync(path); } catch {}
    }
  }
}
