import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import {
  MAX_JOBS,
  resolveStateRoot,
  loadState,
  saveState,
  updateState,
  generateJobId,
  upsertJob,
  readJobFile,
  listJobs,
  getConfig,
  setConfig,
  resolveJobFile,
  resolveJobLogFile,
} from '../scripts/lib/state.mjs';
import { createJobRecord } from '../scripts/lib/tracked-jobs.mjs';

function newRoot() {
  return resolveStateRoot(makeTempDir('state-test-'), 'slug-test');
}

function makeJob(root, id, { updatedAt, sessionId = 'sess-1' } = {}) {
  const job = createJobRecord({
    executor: 'agy',
    kind: 'task',
    request: `request for ${id}`,
    sessionId,
    workspaceRoot: '/tmp/w',
    overrides: { id, createdAt: updatedAt, updatedAt },
  });
  upsertJob(root, job);
  return job;
}

test('upsert/read/list round-trips a job', () => {
  const root = newRoot();
  const job = makeJob(root, 'task-abc');
  assert.ok(readJobFile(root, 'task-abc'));
  assert.equal(readJobFile(root, 'task-abc').request, 'request for task-abc');
  const all = listJobs(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'task-abc');
  assert.deepEqual(job.status, 'queued');
});

test('listJobs returns newest first by updatedAt', () => {
  const root = newRoot();
  makeJob(root, 'task-old', { updatedAt: '2026-01-01T00:00:00.000Z' });
  makeJob(root, 'task-new', { updatedAt: '2026-02-01T00:00:00.000Z' });
  const ids = listJobs(root).map((j) => j.id);
  assert.deepEqual(ids, ['task-new', 'task-old']);
});

test('prune keeps MAX_JOBS newest and deletes orphaned files', () => {
  const root = newRoot();
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < MAX_JOBS + 5; i++) {
    makeJob(root, `task-j${String(i).padStart(2, '0')}`, { updatedAt: new Date(base + i * 1000).toISOString() });
  }
  const all = listJobs(root);
  assert.equal(all.length, MAX_JOBS);
  assert.equal(all[0].id, `task-j${String(MAX_JOBS + 4).padStart(2, '0')}`);
  assert.ok(!existsSync(resolveJobFile(root, 'task-j00')));
  assert.ok(existsSync(resolveJobFile(root, `task-j${String(MAX_JOBS + 4).padStart(2, '0')}`)));
  assert.equal(loadState(root).jobs.length, MAX_JOBS);
});

test('updateState mutates and persists', () => {
  const root = newRoot();
  saveState(root, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  updateState(root, (s) => {
    s.config.stopReviewGate = true;
  });
  assert.equal(loadState(root).config.stopReviewGate, true);
});

test('config get/set round-trips', () => {
  const root = newRoot();
  assert.equal(getConfig(root).stopReviewGate, false);
  setConfig(root, { stopReviewGate: true });
  assert.equal(getConfig(root).stopReviewGate, true);
});

test('generateJobId is unique and prefixed', () => {
  const a = generateJobId('task');
  const b = generateJobId('task');
  assert.ok(a.startsWith('task-'));
  assert.notEqual(a, b);
});

test('job log path resolves alongside job file', () => {
  const root = newRoot();
  const job = createJobRecord({ executor: 'agy', kind: 'review', request: 'x', workspaceRoot: '/w' });
  upsertJob(root, job);
  assert.ok(resolveJobLogFile(root, job.id).endsWith(`${job.id}.log`));
  assert.ok(resolveJobFile(root, job.id).endsWith(`${job.id}.json`));
  assert.ok(existsSync(resolveJobFile(root, job.id)));
});
