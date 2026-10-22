import { join } from 'node:path';
import { closeSync, openSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { ensureDir, readFileSafe, writeJsonAtomic } from './fs.mjs';
import { generateJobId, isoNow } from './state.mjs';
import { appendTaskEvent } from './task-events.mjs';

const STATE_VERSION = 2;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function supervisorDir(root) {
  return join(root, 'supervisor');
}

function supervisorFile(root, id) {
  return join(supervisorDir(root), `${id}.json`);
}
function lockPath(root, id) {
  return `${supervisorFile(root, id)}.lock`;
}

function withLock(root, id, callback) {
  ensureDir(supervisorDir(root));
  const path = lockPath(root, id);
  let fd;
  for (let attempt = 0; ; attempt++) {
    try {
      fd = openSync(path, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 16) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
  try {
    return callback();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  }
}


export function createSupervisorRecord({ cwd, task, config, options = {}, sessionId = null } = {}) {
  const now = isoNow();
  return {
    version: STATE_VERSION,
    id: generateJobId('supervisor'),
    kind: 'run',
    kindLabel: 'Supervisor run',
    title: task.slice(0, 120),
    request: task,
    sessionId,
    workspaceRoot: cwd,
    status: 'running',
    phase: 'planning',
    attempt: 0,
    maxIterations: options.maxIterations,
    maxWorkers: options.maxWorkers,
    integrate: options.integrate,
    allowDirty: options.allowDirty,
    configPath: config.configPath,
    plan: null,
    planner: null,
    plannerJobId: null,
    parallel: null,
    parallelAttempt: null,
    worktree: null,
    workerJobId: null,
    workerConversationId: null,
    worker: null,
    patch: null,
    reviewerJobId: null,
    reviewer: null,
    checks: [],
    evidence: null,
    integration: null,
    feedback: null,
    childJobIds: [],
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };
}

export function saveSupervisor(root, record) {
  ensureDir(supervisorDir(root));
  writeJsonAtomic(supervisorFile(root, record.id), { ...record, updatedAt: isoNow() });
  return record;
}

export function readSupervisor(root, id) {
  const raw = readFileSafe(supervisorFile(root, id), { maxBytes: 64 * 1024 * 1024 });
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listSupervisors(root) {
  let files;
  try {
    files = readdirSync(supervisorDir(root));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter(file => file.endsWith('.json') && !file.startsWith('.'))
    .map(file => readSupervisor(root, file.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id));
}

export function resolveSupervisor(root, id) {
  if (!id) return listSupervisors(root).find(record => !TERMINAL.has(record.status)) ?? null;
  const exact = readSupervisor(root, id);
  if (exact) return exact;
  const matches = listSupervisors(root).filter(record => record.id.startsWith(id));
  if (matches.length > 1) throw new Error(`supervisor id is ambiguous: ${id}`);
  return matches[0] ?? null;
}

export function updateSupervisor(root, id, patch) {
  return withLock(root, id, () => {
    const current = readSupervisor(root, id);
    if (!current) throw new Error(`supervisor record not found: ${id}`);
    if (current.status === 'cancelled' && patch.status !== 'cancelled') return current;
    const next = { ...current, ...patch, updatedAt: isoNow() };
    saveSupervisor(root, next);
    if (next.phase !== current.phase) appendTaskEvent(root, id, 'task.phase', { phase: next.phase, attempt: next.attempt });
    return next;
  });
}

export function finishSupervisor(root, id, status, patch = {}) {
  if (!TERMINAL.has(status)) throw new Error(`invalid supervisor terminal status: ${status}`);
  const record = updateSupervisor(root, id, { ...patch, status, phase: status, completedAt: isoNow() });
  appendTaskEvent(root, id, `task.${record.status}`, { summary: String(record.summary ?? '').slice(0, 8192), error: String(record.errorMessage ?? '').slice(0, 8192) || null, context: record.context ?? null, integrated: record.integrated ?? false });
  return record;
}

export function removeSupervisor(root, id) {
  rmSync(supervisorFile(root, id), { force: true });
}
