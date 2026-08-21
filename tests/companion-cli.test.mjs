import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMain } from '../scripts/agy-companion.mjs';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { resolveStateRoot, listJobs, readJobFile } from '../scripts/lib/state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';
import { get } from '../scripts/lib/executors/registry.mjs';

const executor = get('agy');

const realRunTask = executor.runTask;
const realPreflight = executor.preflight;
const realCollectContext = executor.collectContext;
const realCancel = executor.cancel;

let calls = [];

function stubRunTask(overrides = {}) {
  executor.runTask = async ({ job, prompt, options }) => {
    calls.push({ prompt, options, jobClass: job.jobClass, kind: job.kind });
    return {
      status: 'completed',
      agyStatus: 'SUCCESS',
      response: 'PONG\n',
      conversationId: 'conv-1',
      error: null,
      notice: null,
      usage: null,
      exitCode: 0,
      changedFiles: [],
      ...overrides,
    };
  };
}

function context(dataRoot, env = {}) {
  const outLines = [];
  const errLines = [];
  return {
    cwd: dataRoot,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot, AGY_SESSION_ID: 'sess-1', ...env },
    out: { write: (s) => outLines.push(s) },
    err: { write: (s) => errLines.push(s) },
    outLines,
    errLines,
    root: resolveStateRoot(dataRoot, workspaceSlug(dataRoot)),
  };
}

function freshRoot() {
  return makeTempDir('companion-test-');
}

function prefixOf(ctx) {
  const job = listJobs(ctx.root)[0];
  assert.ok(job, 'expected at least one job');
  return [job.id];
}

before(() => {
  executor.preflight = () => ({ ready: true, binary: true, auth: true, version: '1.1.11', hint: null });
  executor.cancel = async (pid) => {
    calls.push({ cancelPid: pid });
  };
  executor.collectContext = () => ({ promptExtra: '--- a.txt\n+++ b.txt\ndiff line\n', changedFilesHint: ['a.txt'] });
});

after(() => {
  executor.runTask = realRunTask;
  executor.preflight = realPreflight;
  executor.collectContext = realCollectContext;
  executor.cancel = realCancel;
});

test('setup --json reports ready state and persists gate config', async () => {
  calls = [];
  const root = freshRoot();
  const ctx = context(root);
  const code = await runMain(['setup', '--json', '--enable-review-gate'], ctx);
  assert.equal(code, 0);
  const report = JSON.parse(ctx.outLines[0]);
  assert.equal(report.ready, true);
  assert.equal(report.stopReviewGate, true);
  calls = [];
  const ctx2 = context(root);
  await runMain(['setup', '--json', '--disable-review-gate'], ctx2);
  assert.equal(JSON.parse(ctx2.outLines[0]).stopReviewGate, false);
});

test('task --wait runs via executor and prints response verbatim', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  const code = await runMain(['task', 'reply with PONG', '--wait'], ctx);
  assert.equal(code, 0);
  assert.equal(ctx.outLines[0], 'PONG\n');
  assert.equal(calls[0].prompt, 'reply with PONG');
  assert.equal(calls[0].jobClass, 'task');
  const jobs = listJobs(ctx.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].conversationId, 'conv-1');
  assert.equal(jobs[0].sessionId, 'sess-1');
});

test('task --wait failed run exits 1 with error on stderr', async () => {
  calls = [];
  stubRunTask({ status: 'failed', agyStatus: 'ERROR', response: '', error: 'invalid model selection' });
  const root = freshRoot();
  const ctx = context(root);
  const code = await runMain(['task', 'broken', '--wait'], ctx);
  assert.equal(code, 1);
  assert.ok(ctx.errLines.some((l) => l.includes('failed')));
  assert.equal(listJobs(ctx.root)[0].status, 'failed');
});

test('task --background is no longer supported (harness handles it)', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  const code = await runMain(['task', 'background me', '--background'], ctx);
  assert.equal(code, 2);
  assert.ok(ctx.errLines.some((l) => l.includes('--background') || l.includes('not supported')));
});

test('task --resume reuses last conversation when available', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  await runMain(['task', 'first', '--wait'], ctx);
  calls = [];
  await runMain(['task', 'second', '--wait', '--resume'], ctx);
  assert.equal(calls[0].options.conversation, 'conv-1');
});

test('task --fresh clears resume conversation', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  await runMain(['task', 'first', '--wait'], ctx);
  calls = [];
  await runMain(['task', 'second', '--wait', '--resume', '--fresh'], ctx);
  assert.equal(calls[0].options.conversation, null);
});

test('task honors model/effort/agent/approve-all passthrough', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  await runMain(['task', 'x', '--wait', '--model', 'gemini-3.5-flash-medium', '--effort', 'high', '--agent', 'coder', '--approve-all'], ctx);
  assert.equal(calls[0].options.model, 'gemini-3.5-flash-medium');
  assert.equal(calls[0].options.effort, 'high');
  assert.equal(calls[0].options.agent, 'coder');
  assert.equal(calls[0].options.approveAll, true);
});

test('plan with a fixture plan file renders the template with PLAN_TEXT', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const planFile = join(root, 'test-plan.md');
  writeFileSync(planFile, '# Step 1: do thing\n\n- [ ] step one\n');
  const ctx = context(root);
  const code = await runMain(['plan', planFile, '--wait'], ctx);
  assert.equal(code, 0);
  assert.equal(calls[0].kind, 'plan');
  assert.ok(calls[0].prompt.includes('do thing'));
  assert.ok(calls[0].prompt.includes('step one'));
});

test('plan defaults to the newest plan under docs/superpowers/plans', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const dir = join(root, 'docs', 'superpowers', 'plans');
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'old.md'), 'OLD PLAN\n');
  writeFileSync(join(dir, 'new.md'), 'NEW PLAN\n');
  const ctx = context(root);
  await runMain(['plan', '--wait'], ctx);
  assert.ok(calls[0].prompt.includes('NEW PLAN'));
});

test('review --wait collects context and enforces review policy', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  const code = await runMain(['review', '--wait'], ctx);
  assert.equal(code, 0);
  assert.equal(calls[0].kind, 'review');
  assert.equal(calls[0].jobClass, 'review');
  assert.ok(calls[0].options.jsonSchema.endsWith('review-output.schema.json'));
  assert.equal(calls[0].options.approveAll, false);
  assert.ok(calls[0].prompt.includes('diff line'));
});

test('adversarial-review routes to the adversarial template', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const ctx = context(root);
  await runMain(['adversarial-review', 'focus on auth', '--wait'], ctx);
  assert.equal(calls[0].kind, 'adversarial-review');
  assert.ok(calls[0].prompt.includes('adversarial'));
  assert.ok(calls[0].prompt.includes('focus on auth'));
});

test('status lists jobs, filters by session, supports --all and detail', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  await runMain(['task', 'one', '--wait'], context(root));
  await runMain(['task', 'two', '--wait'], context(root));
  await runMain(['task', 'three', '--wait'], context(root, { AGY_SESSION_ID: 'sess-other' }));
  const s1 = context(root);
  await runMain(['status', '--json'], s1);
  assert.equal(JSON.parse(s1.outLines[0]).count, 2);
  const sAll = context(root);
  await runMain(['status', '--json', '--all'], sAll);
  assert.equal(JSON.parse(sAll.outLines[0]).count, 3);
  const sDetail = context(root);
  await runMain(['status', '--json', ...prefixOf(context(root))], sDetail);
  assert.equal(JSON.parse(sDetail.outLines[0]).status, 'completed');
});

test('status --wait blocks until a job is terminal', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  await runMain(['task', 'x', '--wait'], context(root));
  const s = context(root);
  const code = await runMain(['status', '--wait', '--timeout-ms', '10000', ...prefixOf(s)], s);
  assert.equal(code, 0);
});

test('result prints rendered job detail', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  await runMain(['task', 'x', '--wait'], context(root));
  const r = context(root);
  const code = await runMain(['result', '--json', ...prefixOf(r)], r);
  assert.equal(code, 0);
  assert.equal(JSON.parse(r.outLines[0]).result.response, 'PONG\n');
});

test('cancel requires job to exist (--background removed)', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  const c = context(root);
  const code = await runMain(['cancel', 'job-nonexistent'], c);
  assert.notEqual(code, 0);
  assert.ok(c.errLines.some((l) => l.includes('no running or queued job')));
});

test('task-resume-candidate returns the newest resumable job', async () => {
  calls = [];
  stubRunTask();
  const root = freshRoot();
  await runMain(['task', 'first', '--wait'], context(root));
  await runMain(['task', 'second', '--wait'], context(root));
  const r = context(root);
  await runMain(['task-resume-candidate', '--json'], r);
  const candidate = JSON.parse(r.outLines[0]);
  assert.ok(candidate.conversationId);
  assert.equal(candidate.kind, 'task');
  const r2 = context(root, { AGY_SESSION_ID: 'sess-none' });
  await runMain(['task-resume-candidate', '--json'], r2);
  assert.deepEqual(JSON.parse(r2.outLines[0]), {});
});

test('unknown subcommand exits 2', async () => {
  const ctx = context(freshRoot());
  const code = await runMain(['bogus'], ctx);
  assert.equal(code, 2);
});
