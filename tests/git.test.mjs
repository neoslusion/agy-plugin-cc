import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../scripts/lib/process.mjs';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import {
  ensureGitRepository,
  detectDefaultBranch,
  getWorkingTreeState,
  resolveReviewTarget,
  collectReviewContext,
  DEFAULT_INLINE_DIFF_MAX_FILES,
  DEFAULT_INLINE_DIFF_MAX_BYTES,
} from '../scripts/lib/git.mjs';

function gitInit(dir) {
  const opts = { cwd: dir };
  assert.equal(runCommand('git', ['init', '-q'], opts).code, 0, 'git init');
  assert.equal(runCommand('git', ['config', 'user.name', 'Test'], opts).code, 0);
  assert.equal(runCommand('git', ['config', 'user.email', 'test@example.com'], opts).code, 0);
  assert.equal(runCommand('git', ['config', 'core.autocrlf', 'false'], opts).code, 0);
}

function write(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(join(dir, name.split('/')[0] === '' ? '' : name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function commitAll(dir, msg) {
  const opts = { cwd: dir };
  assert.equal(runCommand('git', ['add', '-A'], opts).code, 0);
  assert.equal(runCommand('git', ['commit', '-q', '-m', msg], opts).code, 0);
}

function setupRepo() {
  const dir = makeTempDir('git-test-');
  gitInit(dir);
  write(dir, 'a.txt', 'hello\n');
  write(dir, 'b.txt', 'world\n');
  commitAll(dir, 'initial');
  return dir;
}

test('ensureGitRepository returns root for repos and null otherwise', () => {
  const dir = setupRepo();
  assert.ok(ensureGitRepository(dir));
  const plain = makeTempDir('git-test-plain-');
  assert.equal(ensureGitRepository(plain), null);
});

test('detectDefaultBranch falls back to config or main', () => {
  const dir = setupRepo();
  const branch = detectDefaultBranch(dir);
  assert.ok(branch === 'main' || branch === 'master');
});

test('getWorkingTreeState distinguishes staged/unstaged/untracked', () => {
  const dir = setupRepo();
  write(dir, 'b.txt', 'world staged\n');
  runCommand('git', ['add', 'b.txt'], { cwd: dir });
  write(dir, 'a.txt', 'hello modified\n');
  write(dir, 'c.txt', 'new file\n');
  const state = getWorkingTreeState(dir);
  assert.deepEqual([...state.staged].sort(), ['b.txt']);
  assert.deepEqual([...state.unstaged].sort(), ['a.txt']);
  assert.deepEqual(state.untracked, ['c.txt']);
  assert.equal(state.dirty, true);
});

test('resolveReviewTarget: dirty auto -> working-tree, clean auto -> branch', () => {
  const dir = setupRepo();
  write(dir, 'a.txt', 'dirty\n');
  assert.equal(resolveReviewTarget(dir).kind, 'working-tree');
  runCommand('git', ['checkout', '--', 'a.txt'], { cwd: dir });
  const t = resolveReviewTarget(dir);
  assert.equal(t.kind, 'branch');
  assert.ok(t.base);
  assert.equal(resolveReviewTarget(dir, { scope: 'working-tree' }).kind, 'working-tree');
  assert.equal(resolveReviewTarget(dir, { scope: 'branch', base: 'main' }).base, 'main');
  assert.throws(() => resolveReviewTarget(dir, { scope: 'bogus' }));
});

test('collectReviewContext inline: small working-tree diff carries full diff', () => {
  const dir = setupRepo();
  write(dir, 'a.txt', 'hello inline diff\n');
  const ctx = collectReviewContext(dir, { kind: 'working-tree' });
  assert.equal(ctx.mode, 'inline');
  assert.ok(ctx.diff.includes('hello inline diff'));
  assert.deepEqual(ctx.changedFiles, ['a.txt']);
});

test('collectReviewContext self-collect: too many files trips the heuristic', () => {
  const dir = setupRepo();
  write(dir, 'c.txt', 'c0\n');
  commitAll(dir, 'add c');
  write(dir, 'a.txt', 'a1\n');
  write(dir, 'b.txt', 'b1\n');
  write(dir, 'c.txt', 'c1\n');
  const ctx = collectReviewContext(dir, { kind: 'working-tree' });
  assert.equal(ctx.mode, 'self-collect');
  assert.equal(ctx.changedFiles.length, 3);
  assert.ok(ctx.guidance.includes('read-only git commands'));
});

test('collectReviewContext self-collect: oversized single-file diff trips the byte heuristic', () => {
  const dir = setupRepo();
  const line = 'x'.repeat(80) + '\n';
  const big = line.repeat(Math.ceil(DEFAULT_INLINE_DIFF_MAX_BYTES / 80) + 1);
  const path = join(dir, 'a.txt');
  writeFileSync(path, big);
  runCommand('git', ['add', '-A'], { cwd: dir });
  runCommand('git', ['commit', '-q', '-m', 'big'], { cwd: dir });
  writeFileSync(path, big.replace(/\n/g, 'x\n'));
  const ctx = collectReviewContext(dir, { kind: 'working-tree' });
  assert.equal(ctx.mode, 'self-collect');
  assert.ok(ctx.estimatedBytes > DEFAULT_INLINE_DIFF_MAX_BYTES);
});

test('collectReviewContext inline: small diff stays inline even with maxFiles=1', () => {
  const dir = setupRepo();
  write(dir, 'a.txt', 'small\n');
  const ctx = collectReviewContext(dir, { kind: 'working-tree' }, { maxFiles: 1 });
  assert.equal(ctx.mode, 'inline');
});

test('collectReviewContext branch mode diffs against base', () => {
  const dir = setupRepo();
  runCommand('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
  write(dir, 'feat.txt', 'feature work\n');
  commitAll(dir, 'feature');
  const base = detectDefaultBranch(dir);
  const ctx = collectReviewContext(dir, { kind: 'branch', base });
  assert.equal(ctx.mode, 'inline');
  assert.deepEqual(ctx.changedFiles, ['feat.txt']);
  assert.ok(ctx.diff.includes('feature work'));
});
