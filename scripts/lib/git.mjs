import { join } from 'node:path';
import { runCommand } from './process.mjs';
import { readFileSafe } from './fs.mjs';
export const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
export const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args) {
  return runCommand('git', args, { cwd, env: { ...process.env, GIT_PAGER: 'cat' } });
}
function requiredGit(cwd, args) {
  const result = git(cwd, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}


export function ensureGitRepository(cwd) {
  const res = git(cwd, ['rev-parse', '--show-toplevel']);
  if (res.code !== 0) return null;
  return res.stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const ref = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (ref.code === 0 && ref.stdout.trim()) return ref.stdout.trim().replace(/^origin\//, '');
  const cfg = git(cwd, ['config', '--get', 'init.defaultBranch']);
  if (cfg.code === 0 && cfg.stdout.trim()) return cfg.stdout.trim();
  return 'main';
}

export function getWorkingTreeState(cwd) {
  const res = git(cwd, ['status', '--porcelain']);
  if (res.code !== 0) return { staged: [], unstaged: [], untracked: [], dirty: false };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const name = line.slice(3);
    const path = name.includes(' -> ') ? name.split(' -> ').pop() : name;
    if (xy === '??') {
      untracked.push(path);
      continue;
    }
    if (xy[0] !== ' ') staged.push(path);
    if (xy[1] !== ' ') unstaged.push(path);
  }
  return { staged, unstaged, untracked, dirty: staged.length + unstaged.length + untracked.length > 0 };
}

export function resolveReviewTarget(cwd, { base, scope = 'auto' } = {}) {
  if (scope !== 'auto' && scope !== 'working-tree' && scope !== 'branch') {
    throw new Error(`invalid scope: ${scope} (expected auto|working-tree|branch)`);
  }
  const tree = getWorkingTreeState(cwd);
  let kind;
  if (scope === 'working-tree') kind = 'working-tree';
  else if (scope === 'branch') kind = 'branch';
  else kind = tree.dirty ? 'working-tree' : 'branch';
  return kind === 'branch' ? { kind, base: base ?? detectDefaultBranch(cwd) } : { kind };
}

function parseShortstat(stdout) {
  const files = /(\d+) files? changed/.exec(stdout);
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout);
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

export function collectReviewContext(cwd, target, { maxFiles = DEFAULT_INLINE_DIFF_MAX_FILES, maxBytes = DEFAULT_INLINE_DIFF_MAX_BYTES } = {}) {
  requiredGit(cwd, ['rev-parse', '--show-toplevel']);
  const changedFiles = [];
  let shortstat;
  if (target.kind === 'branch') {
    const base = target.base;
    if (typeof base !== 'string' || !base.trim()) throw new Error('branch review requires a base ref');
    requiredGit(cwd, ['rev-parse', '--verify', `${base}^{commit}`]);
    changedFiles.push(...nameOnly(cwd, ['diff', '--name-only', `${base}...HEAD`], true));
    shortstat = parseShortstat(requiredGit(cwd, ['-c', 'color.ui=never', 'diff', '--shortstat', `${base}...HEAD`]).stdout);
  } else {
    changedFiles.push(...nameOnly(cwd, ['diff', '--name-only'], true));
    changedFiles.push(...nameOnly(cwd, ['diff', '--cached', '--name-only'], true));
    const working = getWorkingTreeState(cwd);
    changedFiles.push(...working.untracked);
    const u = parseShortstat(requiredGit(cwd, ['-c', 'color.ui=never', 'diff', '--shortstat']).stdout);
    const s = parseShortstat(requiredGit(cwd, ['-c', 'color.ui=never', 'diff', '--cached', '--shortstat']).stdout);
    shortstat = { files: u.files + s.files, insertions: u.insertions + s.insertions, deletions: u.deletions + s.deletions };
  }
  const uniqueFiles = [...new Set(changedFiles)];
  if (uniqueFiles.length > maxFiles) {
    return {
      mode: 'self-collect',
      target,
      changedFiles: uniqueFiles,
      estimatedBytes: (shortstat.insertions + shortstat.deletions) * 40,
      guidance: selfCollectGuidance(target, uniqueFiles),
    };
  }
  let diff;
  if (target.kind === 'branch') {
    diff = requiredGit(cwd, ['diff', `${target.base}...HEAD`]).stdout;
  } else {
    const unstaged = requiredGit(cwd, ['diff']).stdout;
    const staged = requiredGit(cwd, ['diff', '--cached']).stdout;
    const parts = [];
    if (staged) parts.push('# STAGED CHANGES\n' + staged);
    if (unstaged) parts.push('# UNSTAGED CHANGES\n' + unstaged);
    for (const file of getWorkingTreeState(cwd).untracked) {
      const content = readFileSafe(join(cwd, file), { maxBytes });
      parts.push(`# UNTRACKED FILE ${file}\n${content ?? '[binary or oversized file omitted]'}`);
    }
    diff = parts.join('\n');
  }
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes > maxBytes) {
    return {
      mode: 'self-collect',
      target,
      changedFiles: uniqueFiles,
      estimatedBytes: bytes,
      guidance: selfCollectGuidance(target, uniqueFiles),
    };
  }
  return { mode: 'inline', target, changedFiles: uniqueFiles, estimatedBytes: bytes, diff };
}


function nameOnly(cwd, args, required = false) {
  const res = git(cwd, ['-c', 'core.quotepath=false', ...args]);
  if (res.code !== 0) {
    if (required) {
      const detail = (res.stderr || res.stdout || res.error?.message || '').trim();
      throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return [];
  }
  return res.stdout.split('\n').filter((l) => l.trim());
}

function selfCollectGuidance(target, files) {
  const cmd =
    target.kind === 'branch'
      ? `git diff ${target.base}...HEAD -- <path>` +
        (files.length ? '' : ' (base: ' + target.base + ')')
      : 'git diff <path> / git diff --cached <path>';
  return (
    `The diff is too large to inline (${files.length} files). ` +
    `Inspect it yourself with read-only git commands (e.g. ${cmd}) rather than asking for the full diff. ` +
    'Do not modify the working tree during the review.'
  );
}
