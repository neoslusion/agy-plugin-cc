import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { ensureDir, readFileSafe, writeJsonAtomic } from './fs.mjs';
import { withLock } from './lock.mjs';

export const MAX_JOBS = 50;
const STATE_VERSION = 1;

export function pluginDataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'agy-companion');
}

export function resolveStateRoot(baseRoot, slug) {
  return join(baseRoot, 'state', slug);
}

function stateFile(root) {
  return join(root, 'state.json');
}

function jobDir(root) {
  return join(root, 'jobs');
}

export function resolveJobFile(root, id) {
  return join(jobDir(root), `${id}.json`);
}

export function resolveJobLogFile(root, id) {
  return join(jobDir(root), `${id}.log`);
}
function jobLockPath(root, id) {
  return `${resolveJobFile(root, id)}.lock`;
}

function withJobLock(root, id, mutate) {
  ensureDir(jobDir(root));
  return withLock(jobLockPath(root, id), mutate);
}

export function mutateJob(root, id, mutate) {
  return withJobLock(root, id, () => {
    const current = readJobFile(root, id);
    if (!current) return null;
    const next = mutate({ ...current });
    if (next) writeJobFile(root, { ...next, updatedAt: next.updatedAt ?? isoNow() });
    return next;
  });
}


export function loadState(root) {
  const raw = readFileSafe(stateFile(root), { maxBytes: 16 * 1024 * 1024 });
  if (raw === null) return { version: STATE_VERSION, config: { stopReviewGate: false }, jobs: listJobs(root).map(j => j.id) };
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? STATE_VERSION,
      config: { stopReviewGate: Boolean(parsed.config?.stopReviewGate), ...parsed.config },
      jobs: listJobs(root).map(j => j.id),
    };
  } catch {
    return { version: STATE_VERSION, config: { stopReviewGate: false }, jobs: listJobs(root).map(j => j.id) };
  }
}

export function saveState(root, state) {
  ensureDir(root);
  writeJsonAtomic(stateFile(root), state);
}

export function updateState(root, mutate) {
  const state = loadState(root);
  mutate(state);
  saveState(root, state);
  return state;
}

export function generateJobId(prefix) {
  const time = Date.now().toString(36);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}-${time}-${rand}`;
}

export function upsertJob(root, job) {
  const merged = withJobLock(root, job.id, () => {
    const record = readJobFile(root, job.id) ?? job;
    const next = { ...record, ...job, updatedAt: job.updatedAt ?? record.updatedAt ?? isoNow() };
    writeJobFile(root, next);
    return next;
  });
  // Terminal dispatches retain their result and retry identity across later tasks.
  const finished = listJobs(root).filter(j => !j.dispatchFingerprint && ['completed', 'failed', 'cancelled'].includes(j.status));
  const dropped = finished.slice(MAX_JOBS);
  for (const old of dropped) {
    try {
      rmSync(resolveJobFile(root, old.id), { force: true });
      rmSync(resolveJobLogFile(root, old.id), { force: true });
    } catch {}
  }
  return merged;
}

export function writeJobFile(root, job) {
  ensureDir(jobDir(root));
  writeJsonAtomic(resolveJobFile(root, job.id), job);
}

export function readJobFile(root, id) {
  const raw = readFileSafe(resolveJobFile(root, id), { maxBytes: 64 * 1024 * 1024 });
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listJobs(root) {
  // Each worker owns its record. Discover records directly so concurrent
  // workers never overwrite a shared read/modify/write job index.
  let files;
  try { files = readdirSync(jobDir(root)); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const jobs = [];
  for (const file of files.filter(f => f.endsWith('.json') && !f.startsWith('.'))) {
    const job = readJobFile(root, file.slice(0, -5));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id));
}

export function getConfig(root) {
  return loadState(root).config;
}

export function setConfig(root, patch) {
  return updateState(root, (state) => {
    state.config = { ...state.config, ...patch };
  }).config;
}

export function isoNow() {
  return new Date().toISOString();
}
