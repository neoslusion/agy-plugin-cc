import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isoNow, generateJobId, readJobFile, resolveJobLogFile, upsertJob } from './state.mjs';

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
  };
}

export function createJobProgressUpdater(root, job) {
  return {
    patch(patch) {
      const record = { ...job, ...patch, updatedAt: isoNow() };
      Object.assign(job, record);
      upsertJob(root, record);
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
  updater.patch({ status: 'running', phase: 'starting', startedAt: job.startedAt ?? isoNow(), pid: job.pid ?? process.pid });
  try {
    const result = await run(createProgressReporter(root, job));
    updater.patch({ status: 'completed', phase: 'done', result, completedAt: isoNow(), exitCode: 0, errorMessage: null });
  } catch (err) {
    updater.patch({ status: 'failed', phase: 'failed', errorMessage: err?.message ?? String(err), completedAt: isoNow(), exitCode: 1 });
  }
  return readJobFile(root, job.id);
}
