import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCommand } from './process.mjs';

const MAX_PATCH_BYTES = 32 * 1024 * 1024;

function git(cwd, args, { env = process.env, timeoutMs = 120_000 } = {}) {
  return runCommand('git', args, {
    cwd,
    env: { ...env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    timeoutMs,
  });
}

function checked(cwd, args, options) {
  const result = git(cwd, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function supervisorGitRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) throw new Error('supervisor requires a Git repository with at least one commit');
  return result.stdout.trim();
}

export function requireCleanParent(cwd, { allowDirty = false } = {}) {
  const result = checked(cwd, ['status', '--porcelain']);
  const status = result.stdout;
  if (status.trim() && !allowDirty) throw new Error('supervisor requires a clean parent worktree; commit, stash, or use --allow-dirty explicitly');
  return { clean: !status.trim(), status };
}

export function createWorkerWorktree(cwd, { allowDirty = false, env = process.env } = {}) {
  const root = supervisorGitRoot(cwd);
  requireCleanParent(cwd, { allowDirty, env });
  const baseCommit = checked(cwd, ['rev-parse', 'HEAD'], { env }).stdout.trim();
  const parent = mkdtempSync(join(tmpdir(), 'agent-delegation-worktree-'));
  const worktreePath = join(parent, 'worker');
  const result = git(cwd, ['worktree', 'add', '--detach', worktreePath, baseCommit], { env });
  if (result.code !== 0) {
    rmSync(parent, { recursive: true, force: true });
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`failed to create isolated worker worktree${detail ? `: ${detail}` : ''}`);
  }
  return { root, parent, worktreePath, baseCommit };
}

export function captureWorkerPatch(worktreePath, { baseCommit, patchFile, env = process.env } = {}) {
  if (!worktreePath || !baseCommit || !patchFile) throw new Error('captureWorkerPatch requires worktreePath, baseCommit, and patchFile');
  checked(worktreePath, ['add', '-A'], { env });
  const diff = checked(worktreePath, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', baseCommit, '--'], { env });
  if (Buffer.byteLength(diff.stdout, 'utf8') > MAX_PATCH_BYTES) throw new Error(`worker patch exceeds ${MAX_PATCH_BYTES} bytes`);
  writeFileSync(patchFile, diff.stdout, 'utf8');
  const names = checked(worktreePath, ['diff', '--cached', '--name-only', '-z', baseCommit, '--'], { env }).stdout;
  const changedFiles = names.split('\0').filter(Boolean);
  return {
    file: patchFile,
    hash: createHash('sha256').update(diff.stdout).digest('hex'),
    bytes: Buffer.byteLength(diff.stdout, 'utf8'),
    changedFiles,
    empty: diff.stdout.length === 0,
  };
}

export function checkPatch(cwd, patchFile, { env = process.env } = {}) {
  return checked(cwd, ['apply', '--check', '--whitespace=nowarn', patchFile], { env });
}

export function applyPatch(cwd, patchFile, { env = process.env } = {}) {
  checkPatch(cwd, patchFile, { env });
  return checked(cwd, ['apply', '--whitespace=nowarn', patchFile], { env });
}

export function patchAlreadyApplied(cwd, patchFile, { env = process.env } = {}) {
  const reverse = git(cwd, ['apply', '--reverse', '--check', '--whitespace=nowarn', patchFile], { env });
  return reverse.code === 0;
}

export function cleanupWorkerWorktree(worktree, { env = process.env } = {}) {
  if (!worktree?.worktreePath) return { removed: false, error: 'missing worktree path' };
  const result = git(worktree.root, ['worktree', 'remove', '--force', worktree.worktreePath], { env });
  if (result.code === 0) {
    rmSync(worktree.parent, { recursive: true, force: true });
    return { removed: true, path: relative(process.cwd(), worktree.worktreePath) };
  }
  const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
  return { removed: false, path: worktree.worktreePath, error: detail };
}

export function patchPathFor(root, id) {
  return join(root, 'supervisor', `${id}.patch`);
}

export const MAX_SUPERVISOR_PATCH_BYTES = MAX_PATCH_BYTES;
