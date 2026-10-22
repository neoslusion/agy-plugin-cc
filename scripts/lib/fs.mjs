import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function readFileSafe(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;
  let buf;
  try { buf = readFileSync(path); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

export function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    // Windows readers can briefly hold a sharing lock while another worker lists jobs.
    // Retry the atomic replacement; never unlink the destination to make it succeed.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, path); break; }
      catch (err) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= 8) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } catch (err) {
    try {
      rmSync(tmp);
    } catch {}
    throw err;
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function safeBasename(p) {
  return basename(p) || 'root';
}

export function sanitizeSlug(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}
