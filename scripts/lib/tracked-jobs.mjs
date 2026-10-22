import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isoNow, generateJobId, mutateJob, readJobFile, resolveJobLogFile, upsertJob } from './state.mjs';
import { appendTaskEvent } from './task-events.mjs';

export const KIND_LABELS = {
  task: 'Task',
  plan: 'Plan',
  review: 'Code review',
  'adversarial-review': 'Adversarial review',
};

export const WRITE_KINDS = new Set(['task', 'plan']);

export function createJobRecord({ executor, kind, request, sessionId, workspaceRoot, overrides = {} }) {
  const now = isoNow();
  return {
    version: 1,
    id: overrides.id ?? generateJobId(kind),
    executor,
    kind,
    kindLabel: overrides.kindLabel ?? KIND_LABELS[kind] ?? kind,
    title: overrides.title ?? (typeof request === 'string' ? request.slice(0, 120) : ''),
    summary: overrides.summary ?? null,
    workspaceRoot,
    jobClass: WRITE_KINDS.has(kind) ? 'task' : 'review',
    write: WRITE_KINDS.has(kind),
    sessionId: sessionId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    startedAt: overrides.startedAt ?? null,
    completedAt: null,
    cancelledAt: null,
    status: 'queued',
    phase: 'queued',
    pid: null,
    logFile: null,
    conversationId: null,
    exitCode: null,
    errorMessage: null,
    result: null,
    rendered: null,
    request,
    assignment: request,
    ...overrides,
  };
}

export function createJobLogFile(root, job) {
  const logFile = resolveJobLogFile(root, job.id);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `# ${job.kindLabel} ${job.id} @ ${job.createdAt}\n`);
  job.logFile = logFile;
  return logFile;
}

export function appendLogLine(root, job, line) {
  const logFile = job.logFile ?? createJobLogFile(root, job);
  appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  return logFile;
}

export function appendLogBlock(root, job, text) {
  const logFile = job.logFile ?? createJobLogFile(root, job);
  appendFileSync(logFile, `${text}\n`);
  return logFile;
}

export function createProgressReporter(root, job) {
  const updater = createJobProgressUpdater(root, job);
  return {
    update: (patch) => updater.patch(patch),
    setPhase: (phase) => updater.setPhase(phase),
    log: (line) => appendLogLine(root, job, line),
    event: (type, data) => appendTaskEvent(root, job.id, type, data),
  };
}

export function createJobProgressUpdater(root, job) {
  return {
    patch(patch) {
      const record = mutateJob(root, job.id, current => {
        if (!current) return { ...job, ...patch };
        if (current.status === 'cancelled') return current;
        return { ...current, ...patch };
      }) ?? upsertJob(root, { ...job, ...patch });
      if (record) Object.assign(job, record);
      return record;
    },
    setStatus(status) {
      this.patch({ status });
    },
    setPhase(phase) {
      this.patch({ phase });
    },
  };
}

export async function runTrackedJob({ root, job, run }) {
  const updater = createJobProgressUpdater(root, job);
  // A queued dispatch already exists on disk; preserve its newly prepared prompt.
  const started = updater.patch({ status: 'running', phase: 'starting', startedAt: job.startedAt ?? isoNow(), pid: job.pid ?? process.pid, workerPid: job.workerPid ?? process.pid, ...(job.request !== undefined ? { request: job.request } : {}) });
  if (started.status === 'cancelled') return started;
  appendTaskEvent(root, job.id, 'task.started', { executor: job.executor, role: job.role ?? null, integration: job.integration ?? 'cli', context: job.context ?? null });
  try {
    const result = await run(createProgressReporter(root, job));
    const persisted = readJobFile(root, job.id);
    if (persisted?.status === 'cancelled') return persisted;
    const status = result?.status ?? 'completed';
    if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error(`Invalid task terminal status: ${status}`);
    updater.patch({ status, phase: status === 'completed' ? 'done' : status, result, completedAt: isoNow(), exitCode: result?.exitCode ?? (status === 'completed' ? 0 : 1), errorMessage: result?.error ?? null });
    appendTaskEvent(root, job.id, `task.${status}`, { conversationId: job.conversationId ?? result?.conversationId ?? null, summary: String(result?.response ?? '').slice(0, 8192), error: String(result?.error ?? '').slice(0, 8192) || null, changedFiles: result?.changedFiles?.slice(0, 256) ?? [], context: job.context ?? null });
  } catch (err) {
    const persisted = readJobFile(root, job.id);
    if (persisted?.status === 'cancelled') return persisted;
    updater.patch({ status: 'failed', phase: 'failed', errorMessage: err?.message ?? String(err), completedAt: isoNow(), exitCode: 1 });
    appendTaskEvent(root, job.id, 'task.failed', { error: String(err?.message ?? err).slice(0, 8192), context: job.context ?? null });
  }
  return readJobFile(root, job.id);
}
