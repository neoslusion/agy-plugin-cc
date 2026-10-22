import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../scripts/lib/process.mjs';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { collectReviewContext } from '../scripts/lib/git.mjs';
import {
  applyPatch,
  captureWorkerPatch,
  cleanupWorkerWorktree,
  createWorkerWorktree,
} from '../scripts/lib/supervisor-git.mjs';

function git(cwd, args) {
  const result = runCommand('git', args, { cwd });
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function repository() {
  const cwd = makeTempDir('supervisor git repository ');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Supervisor Test']);
  git(cwd, ['config', 'user.email', 'supervisor@example.com']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'initial']);
  return cwd;
}

test('worktree patch capture includes new files and applies centrally', () => {
  const cwd = repository();
  const worktree = createWorkerWorktree(cwd);
  const patchFile = join(makeTempDir('supervisor patch '), 'change.patch');
  try {
    writeFileSync(join(worktree.worktreePath, 'created.txt'), 'created\n');
    const patch = captureWorkerPatch(worktree.worktreePath, { baseCommit: worktree.baseCommit, patchFile });
    assert.deepEqual(patch.changedFiles, ['created.txt']);
    assert.equal(patch.empty, false);
    assert.equal(runCommand('git', ['status', '--porcelain'], { cwd }).stdout, '');
    applyPatch(cwd, patchFile);
    assert.equal(runCommand('git', ['status', '--porcelain'], { cwd }).stdout.includes('created.txt'), true);
  } finally {
    const cleanup = cleanupWorkerWorktree(worktree);
    assert.equal(cleanup.removed, true, cleanup.error);
  }
});

test('review context includes untracked content and rejects invalid refs', () => {
  const cwd = repository();
  writeFileSync(join(cwd, 'untracked.txt'), 'UNTRACKED_CONTENT\n');
  const context = collectReviewContext(cwd, { kind: 'working-tree' });
  assert.equal(context.mode, 'inline');
  assert.ok(context.changedFiles.includes('untracked.txt'));
  assert.match(context.diff, /UNTRACKED_CONTENT/);
  assert.throws(() => collectReviewContext(cwd, { kind: 'branch', base: 'missing-ref' }), /git .*failed/);
  assert.throws(() => collectReviewContext(makeTempDir('not a repo '), { kind: 'working-tree' }), /git .*failed/);
});

test('patch application fails without partially changing the parent', () => {
  const cwd = repository();
  const worktree = createWorkerWorktree(cwd);
  const patchFile = join(makeTempDir('supervisor conflict '), 'change.patch');
  try {
    writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'worker change\n');
    const patch = captureWorkerPatch(worktree.worktreePath, { baseCommit: worktree.baseCommit, patchFile });
    writeFileSync(join(cwd, 'tracked.txt'), 'parent change\n');
    assert.throws(() => applyPatch(cwd, patchFile));
    assert.equal(runCommand('git', ['status', '--porcelain'], { cwd }).stdout.includes('UU'), false);
  } finally {
    cleanupWorkerWorktree(worktree);
  }
});
