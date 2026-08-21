import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { resolveStateRoot, readJobFile, listJobs, upsertJob } from '../scripts/lib/state.mjs';
import {
  createJobRecord,
  createJobLogFile,
  appendLogLine,
  createProgressReporter,
  runTrackedJob,
} from '../scripts/lib/tracked-jobs.mjs';
import {
  sortJobsNewestFirst,
  enrichJob,
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  resolveResultJob,
  resolveCancelableJob,
} from '../scripts/lib/job-control.mjs';

function newRoot() {
  return resolveStateRoot(makeTempDir('tracked-test-'), 'slug-test');
}

function save(root, job) {
  upsertJob(root, job);
  return job;
}

test('createJobRecord derives jobClass/write/kindLabel from kind', () => {
  const task = createJobRecord({ executor: 'agy', kind: 'task', request: 'do it', sessionId: 's1', workspaceRoot: '/w' });
  assert.equal(task.jobClass, 'task');
  assert.equal(task.write, true);
  assert.equal(task.status, 'queued');
  assert.equal(task.phase, 'queued');
  const review = createJobRecord({ executor: 'agy', kind: 'review', request: 'review', workspaceRoot: '/w' });
  assert.equal(review.jobClass, 'review');
  assert.equal(review.write, false);
  assert.equal(review.kindLabel, 'Code review');
  assert.equal(createJobRecord({ executor: 'agy', kind: 'adversarial-review', request: 'x', workspaceRoot: '/w' }).kindLabel, 'Adversarial review');
});

test('runTrackedJob success marks completed with result', async () => {
  const root = newRoot();
  const job = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'pong', sessionId: 's1', workspaceRoot: '/w' }));
  const final = await runTrackedJob({
    root,
    job,
    run: async (progress) => {
      progress.setPhase('acting');
      progress.log('running pong');
      return 'PONG\n';
    },
  });
  assert.equal(final.status, 'completed');
  assert.equal(final.phase, 'done');
  assert.equal(final.result, 'PONG\n');
  assert.equal(final.exitCode, 0);
  assert.ok(final.startedAt);
  assert.ok(final.completedAt);
  assert.ok(readJobFile(root, job.id).status === 'completed');
});

test('runTrackedJob failure marks failed with errorMessage', async () => {
  const root = newRoot();
  const job = save(root, createJobRecord({ executor: 'agy', kind: 'review', request: 'x', workspaceRoot: '/w' }));
  const final = await runTrackedJob({
    root,
    job,
    run: () => {
      throw new Error('boom');
    },
  });
  assert.equal(final.status, 'failed');
  assert.equal(final.phase, 'failed');
  assert.equal(final.errorMessage, 'boom');
  assert.equal(final.exitCode, 1);
});

test('progress reporter persists patches and appends to log', () => {
  const root = newRoot();
  const job = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'x', workspaceRoot: '/w' }));
  createJobLogFile(root, job);
  const reporter = createProgressReporter(root, job);
  reporter.update({ conversationId: 'conv-1' });
  reporter.setPhase('acting');
  reporter.log('line one');
  reporter.log('line two');
  const persisted = readJobFile(root, job.id);
  assert.equal(persisted.conversationId, 'conv-1');
  assert.equal(persisted.phase, 'acting');
  const logText = readFileSync(job.logFile, 'utf8');
  assert.ok(logText.includes('line one'));
  assert.ok(logText.includes('line two'));
  assert.ok(existsSync(job.logFile));
});

test('buildStatusSnapshot filters by session unless all', () => {
  const root = newRoot();
  const j1 = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'a', sessionId: 's1', workspaceRoot: '/w' }));
  const j2 = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'b', sessionId: 's2', workspaceRoot: '/w' }));
  const filtered = buildStatusSnapshot({ jobs: [j1, j2], sessionId: 's1' });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.jobs[0].id, j1.id);
  const all = buildStatusSnapshot({ jobs: [j1, j2], sessionId: 's1', all: true });
  assert.equal(all.count, 2);
});

test('sortJobsNewestFirst orders by updatedAt desc; enrichJob adds display fields', () => {
  const old = createJobRecord({ executor: 'agy', kind: 'task', request: 'a', workspaceRoot: '/w', overrides: { updatedAt: '2026-01-01T00:00:00.000Z', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:05.000Z' } });
  const fresh = createJobRecord({ executor: 'agy', kind: 'task', request: 'b', workspaceRoot: '/w', overrides: { updatedAt: '2026-02-01T00:00:00.000Z' } });
  const sorted = sortJobsNewestFirst([old, fresh]);
  assert.equal(sorted[0].id, fresh.id);
  const enriched = enrichJob(old);
  assert.equal(enriched.kindLabel, 'Task');
  assert.equal(enriched.durationMs, 5000);
  assert.equal(enriched.cancellable, false);
  assert.equal(enrichJob(fresh).cancellable, true);
  assert.deepEqual(buildSingleJobSnapshot(old).job.id, old.id);
});

test('resolveResultJob: prefix match, ambiguity throws', () => {
  const root = newRoot();
  const j1 = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'a', workspaceRoot: '/w', overrides: { id: 'task-aaaa-1' } }));
  const j2 = save(root, createJobRecord({ executor: 'agy', kind: 'task', request: 'b', workspaceRoot: '/w', overrides: { id: 'task-aaab-2' } }));
  assert.equal(resolveResultJob([j1, j2], 'task-aaaa').id, j1.id);
  assert.throws(() => resolveResultJob([j1, j2], 'task-aaa'), /ambiguous/);
  assert.throws(() => resolveResultJob([j1, j2], 'nope'), /no job matches/);
  assert.throws(() => resolveResultJob([j1, j2], ''), /required/);
});

test('resolveCancelableJob only resolves running/queued jobs', () => {
  const done = createJobRecord({ executor: 'agy', kind: 'task', request: 'a', workspaceRoot: '/w', overrides: { id: 'task-done-1', status: 'completed' } });
  const running = createJobRecord({ executor: 'agy', kind: 'task', request: 'b', workspaceRoot: '/w', overrides: { id: 'task-run-1', status: 'running' } });
  const running2 = createJobRecord({ executor: 'agy', kind: 'task', request: 'c', workspaceRoot: '/w', overrides: { id: 'task-run-2', status: 'running' } });
  assert.equal(resolveCancelableJob([done, running], 'task-run').id, 'task-run-1');
  assert.throws(() => resolveCancelableJob([done, running], 'task-done'), /no running or queued/);
  assert.throws(() => resolveCancelableJob([done, running, running2], 'task'), /ambiguous/);
});
