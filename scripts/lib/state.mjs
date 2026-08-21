import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { ensureDir, readFileSafe, writeJsonAtomic } from './fs.mjs';

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

export function loadState(root) {
  const raw = readFileSafe(stateFile(root), { maxBytes: 16 * 1024 * 1024 });
  if (raw === null) return { version: STATE_VERSION, config: { stopReviewGate: false }, jobs: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? STATE_VERSION,
      config: { stopReviewGate: Boolean(parsed.config?.stopReviewGate), ...parsed.config },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return { version: STATE_VERSION, config: { stopReviewGate: false }, jobs: [] };
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
  const record = readJobFile(root, job.id) ?? job;
  const merged = { ...record, ...job, updatedAt: job.updatedAt ?? record.updatedAt ?? isoNow() };
  writeJobFile(root, merged);
  updateState(root, (state) => {
    if (!state.jobs.includes(merged.id)) state.jobs.push(merged.id);
  });
  const all = listJobs(root);
  all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const kept = all.slice(0, MAX_JOBS);
  const dropped = all.slice(MAX_JOBS);
  for (const old of dropped) {
    try {
      rmSync(resolveJobFile(root, old.id), { force: true });
    } catch {}
  }
  updateState(root, (state) => {
    state.jobs = kept.map((j) => j.id);
  });
  return merged;
}

export function writeJobFile(root, job) {
  ensureDir(jobDir(root));
  writeJsonAtomic(resolveJobFile(root, job.id), job);
}

export function readJobFile(root, id) {
  const raw = readFileSafe(resolveJobFile(root, id));
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listJobs(root) {
  const state = loadState(root);
  const jobs = [];
  for (const id of state.jobs) {
    const job = readJobFile(root, id);
    if (job) jobs.push(job);
  }
  return jobs;
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
