import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { resolveStateRoot, listJobs } from '../scripts/lib/state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';
import { runMain } from '../scripts/agy-companion.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const FAKE_AGY = join(PLUGIN_ROOT, 'tests', 'fixtures', 'fake-agy', 'fake-agy.mjs');

let savedBinary;
let savedScenario;

before(() => {
  savedBinary = process.env.AGY_BINARY;
  savedScenario = process.env.FAKE_AGY_SCENARIO;
  process.env.AGY_BINARY = FAKE_AGY;
});

after(() => {
  if (savedBinary === undefined) delete process.env.AGY_BINARY;
  else process.env.AGY_BINARY = savedBinary;
  if (savedScenario === undefined) delete process.env.FAKE_AGY_SCENARIO;
  else process.env.FAKE_AGY_SCENARIO = savedScenario;
});

function setScenario(scenario) {
  process.env.FAKE_AGY_SCENARIO = JSON.stringify(scenario);
}

function context() {
  const dir = makeTempDir('fakeagy-');
  const outLines = [];
  const errLines = [];
  return {
    cwd: dir,
    root: resolveStateRoot(dir, workspaceSlug(dir)),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, AGY_SESSION_ID: 'sess-fake' },
    out: { write: (s) => outLines.push(s) },
    err: { write: (s) => errLines.push(s) },
    outLines,
    errLines,
  };
}

test('companion task runs end-to-end against the fake agy binary', async () => {
  setScenario({});
  const ctx = context();
  const code = await runMain(['task', 'reply with PONG', '--wait'], ctx);
  assert.equal(code, 0);
  assert.equal(ctx.outLines[0], 'PONG\n');
  const jobs = listJobs(ctx.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].conversationId, 'fake-conv-1');
});

test('harness now handles background execution (--background removed)', async () => {
  setScenario({ delayMs: 100 });
  const dir = makeTempDir('fakeagy-');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'agy-companion.mjs'), 'task', 'work', '--background'], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, AGY_SESSION_ID: 'sess-fake' },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(res.status, 0, 'should reject --background flag');
  assert.ok(res.stderr.includes('--background') || res.stderr.includes('not supported'), `unexpected stderr: ${res.stderr}`);
});

test('companion task propagates soft-deny notices from the fake binary', async () => {
  setScenario({ response: '', notice: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.' });
  const ctx = context();
  const code = await runMain(['task', 'run something', '--wait'], ctx);
  assert.equal(code, 0);
  assert.ok(ctx.errLines.some((l) => l.includes('auto-denied')));
});

test('companion task fails when the fake binary reports ERROR', async () => {
  setScenario({ status: 'ERROR', error: 'invalid model selection' });
  const ctx = context();
  const code = await runMain(['task', 'broken', '--wait'], ctx);
  assert.equal(code, 1);
  assert.ok(ctx.errLines.some((l) => l.includes('invalid model')));
});
