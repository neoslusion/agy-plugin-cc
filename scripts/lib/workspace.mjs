import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realPath, safeBasename, sanitizeSlug } from './fs.mjs';
import { ensureGitRepository } from './git.mjs';

export function resolveWorkspaceRoot(cwd) {
  return ensureGitRepository(cwd) ?? cwd;
}

export function workspaceSlug(cwd) {
  const root = realPath(resolveWorkspaceRoot(cwd));
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return `${sanitizeSlug(safeBasename(root))}-${hash}`;
}

export function workspaceStateDir(stateRoot, cwd) {
  return join(stateRoot, 'state', workspaceSlug(cwd));
}
