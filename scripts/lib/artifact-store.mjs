import { ensureDir } from './fs.mjs';
import { withLock } from './lock.mjs';

export function artifactId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid artifact ID');
  return value;
}

export function withArtifactLock(directory, action) {
  ensureDir(directory);
  return withLock(`${directory}/.lock`, action);
}
