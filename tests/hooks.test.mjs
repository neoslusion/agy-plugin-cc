import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { resolveStateRoot, listJobs } from '../scripts/lib/state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';
import { runMain } from '../scripts/agy-companion.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const FAKE_AGY = join(PLUGIN_ROOT, 'tests', 'fixtures', 'fake-agy', 'fake-agy.mjs');

function runHook(script, args, payload, env = {}) {
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGY_USE_BROKER: 'false', ...env },
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeRoot() {
  const dir = makeTempDir('hooks-test-');
  return { dir, root: resolveStateRoot(dir, workspaceSlug(dir)) };
}

function makeTranscript(dir, text) {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'do something' }] } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  return path;
}

test('SessionStart hook exports session env vars to the env file', () => {
  const { dir } = makeRoot();
  const envFile = join(dir, 'env.txt');
  const res = runHook('session-lifecycle-hook.mjs', ['SessionStart'], {
    session_id: 'sess-42',
    transcript_path: join(dir, 't.jsonl'),
    cwd: dir,
    env_file: envFile,
  });
  assert.equal(res.status, 0);
  const text = readFileSync(envFile, 'utf8');
  assert.ok(text.includes('AGY_SESSION_ID=sess-42'));
  assert.ok(text.includes('AGY_TRANSCRIPT_PATH='));
  assert.ok(text.includes('AGENT_DELEGATION_DATA='));
});

test('SessionStart exports AGY_APPROVE_ALL only for bypassPermissions sessions', () => {
  const { dir } = makeRoot();
  const bypassFile = join(dir, 'env-bypass.txt');
  runHook('session-lifecycle-hook.mjs', ['SessionStart'], {
    session_id: 'sess-b',
    cwd: dir,
    env_file: bypassFile,
    permission_mode: 'bypassPermissions',
  });
  const bypassText = readFileSync(bypassFile, 'utf8');
  assert.ok(bypassText.includes('AGY_PERMISSION_MODE=bypassPermissions'));
  assert.ok(bypassText.includes('AGY_APPROVE_ALL=1'));

  const defaultFile = join(dir, 'env-default.txt');
  runHook('session-lifecycle-hook.mjs', ['SessionStart'], {
    session_id: 'sess-d',
    cwd: dir,
    env_file: defaultFile,
    permission_mode: 'default',
  });
  const defaultText = readFileSync(defaultFile, 'utf8');
  assert.ok(defaultText.includes('AGY_PERMISSION_MODE=default'));
  assert.ok(!defaultText.includes('AGY_APPROVE_ALL'));

  const legacyFile = join(dir, 'env-legacy.txt');
  runHook('session-lifecycle-hook.mjs', ['SessionStart'], {
    session_id: 'sess-l',
    cwd: dir,
    env_file: legacyFile,
  });
  assert.ok(!readFileSync(legacyFile, 'utf8').includes('AGY_APPROVE_ALL'));
});

test('SessionEnd hook cancels orphaned jobs for the session', async () => {
  const { dir, root } = makeRoot();
  const job = { id: 'task-hook-1', executor: 'agy', sessionId: 'sess-end', status: 'running', phase: 'acting', pid: 999999, updatedAt: new Date().toISOString(), kind: 'task' };
  const { upsertJob, readJobFile } = await import('../scripts/lib/state.mjs');
  upsertJob(root, job);
  const res = runHook('session-lifecycle-hook.mjs', ['SessionEnd'], { session_id: 'sess-end', cwd: dir }, { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(res.status, 0);
  assert.equal(readJobFile(root, 'task-hook-1').status, 'cancelled');
  const other = { ...job, id: 'task-other-1', sessionId: 'sess-other' };
  upsertJob(root, other);
  const res2 = runHook('session-lifecycle-hook.mjs', ['SessionEnd'], { session_id: 'sess-end', cwd: dir }, { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(res2.status, 0);
  assert.equal(readJobFile(root, 'task-other-1').status, 'running');
});

test('stop gate no-ops when disabled', async () => {
  const { dir } = makeRoot();
  const transcript = makeTranscript(dir, 'I edited files.');
  const res = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: false, transcript_path: transcript, cwd: dir, session_id: 's' }, { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('stop gate skips repeated stops and delegated workers even when enabled', async () => {
  const { dir, root } = makeRoot();
  const { setConfig } = await import('../scripts/lib/state.mjs');
  setConfig(root, { stopReviewGate: true });
  const transcript = makeTranscript(dir, 'unfinished work');
  for (const [active, worker] of [[true, ''], [false, '1']]) {
    const result = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: active, transcript_path: transcript, cwd: dir }, {
      CLAUDE_PLUGIN_DATA: dir, AGENT_DELEGATION_WORKER: worker, AGY_BINARY: FAKE_AGY,
      FAKE_AGY_SCENARIO: JSON.stringify({ decision: 'BLOCK' }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(listJobs(root).length, 0);
  }
});

test('stop gate allows when the model says ALLOW (via fake agy)', async () => {
  const { dir, root } = makeRoot();
  await runMain(['setup', '--enable-review-gate'], { cwd: dir, env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, out: { write: () => {} }, err: { write: () => {} } });
  const transcript = makeTranscript(dir, 'I finished the refactor and the tests pass.');
  const res = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: false, transcript_path: transcript, cwd: dir, session_id: 'sess-gate' }, {
    CLAUDE_PLUGIN_DATA: dir,
    AGY_BINARY: FAKE_AGY,
    FAKE_AGY_SCENARIO: JSON.stringify({ decision: 'ALLOW', reason: 'work complete' }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('stop gate blocks with a reason (via fake agy)', async () => {
  const { dir } = makeRoot();
  await runMain(['setup', '--enable-review-gate'], { cwd: dir, env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, out: { write: () => {} }, err: { write: () => {} } });
  const transcript = makeTranscript(dir, 'About to run the migration now...');
  const res = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: false, transcript_path: transcript, cwd: dir, session_id: 'sess-gate' }, {
    CLAUDE_PLUGIN_DATA: dir,
    AGY_BINARY: FAKE_AGY,
    FAKE_AGY_SCENARIO: JSON.stringify({ decision: 'BLOCK', reason: 'migration left mid-flight' }),
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'migration left mid-flight');
});

test('stop gate fails open on executor ERROR', async () => {
  const { dir } = makeRoot();
  await runMain(['setup', '--enable-review-gate'], { cwd: dir, env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, out: { write: () => {} }, err: { write: () => {} } });
  const transcript = makeTranscript(dir, 'half way through');
  const res = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: false, transcript_path: transcript, cwd: dir, session_id: 'sess-gate' }, {
    CLAUDE_PLUGIN_DATA: dir,
    AGY_BINARY: FAKE_AGY,
    FAKE_AGY_SCENARIO: JSON.stringify({ status: 'ERROR', error: 'model unavailable' }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('hooks exit promptly when stdin is never closed (real-session TTY case)', () => {
  for (const [script, args] of [
    ['session-lifecycle-hook.mjs', ['SessionEnd']],
    ['stop-review-gate-hook.mjs', []],
  ]) {
    const start = Date.now();
    const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir('tty-') },
      timeout: 10_000,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 9_000, `${script} took ${elapsed}ms — would be cancelled by the 5s hook timeout`);
    assert.equal(res.status, 0, `${script} exited non-zero: ${res.status}`);
  }
});

test('stop gate fails open on timeout', async () => {
  const { dir } = makeRoot();
  await runMain(['setup', '--enable-review-gate'], { cwd: dir, env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, out: { write: () => {} }, err: { write: () => {} } });
  const stub = join(dir, 'hanging-companion.mjs');
  writeFileSync(stub, "setTimeout(() => process.exit(0), 10000);\n");
  const transcript = makeTranscript(dir, 'half way through');
  const res = runHook('stop-review-gate-hook.mjs', [], { stop_hook_active: false, transcript_path: transcript, cwd: dir, session_id: 'sess-gate' }, {
    CLAUDE_PLUGIN_DATA: dir,
    AGY_COMPANION_SCRIPT: stub,
    AGY_GATE_TIMEOUT_MS: '300',
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
