import { closeSync, openSync, unlinkSync } from 'node:fs';
import { ensureDir } from './fs.mjs';

export function artifactId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid artifact ID');
  return value;
}

export function withArtifactLock(directory, action) {
  ensureDir(directory);
  const path = `${directory}/.lock`;
  let fd;
  for (let attempt = 0; ; attempt++) {
    try { fd = openSync(path, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 16) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
  try { return action(); }
  finally { closeSync(fd); unlinkSync(path); }
}
