import { KIND_LABELS } from './tracked-jobs.mjs';

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export function enrichJob(job) {
  if (!job) return null;
  const durationMs =
    job.completedAt && job.startedAt ? Date.parse(job.completedAt) - Date.parse(job.startedAt) : null;
  return {
    ...job,
    kindLabel: job.kindLabel ?? KIND_LABELS[job.kind] ?? job.kind,
    durationMs,
    cancellable: job.status === 'running' || job.status === 'queued',
  };
}

export function buildStatusSnapshot({ jobs, sessionId, all = false }) {
  const filtered = all ? jobs : jobs.filter((j) => !sessionId || j.sessionId === sessionId);
  const enriched = sortJobsNewestFirst(filtered).map(enrichJob);
  return { jobs: enriched, count: enriched.length, all };
}

export function buildSingleJobSnapshot(job) {
  return { job: enrichJob(job) };
}

function matchByPrefix(jobs, prefix) {
  return jobs.filter((j) => j.id.startsWith(prefix));
}

export function resolveResultJob(jobs, idOrPrefix) {
  if (!idOrPrefix) throw new Error('a job id or prefix is required');
  const matches = matchByPrefix(jobs, idOrPrefix);
  if (matches.length === 0) throw new Error(`no job matches "${idOrPrefix}"`);
  if (matches.length > 1) {
    throw new Error(`ambiguous job prefix "${idOrPrefix}" matches: ${matches.map((j) => j.id).join(', ')}`);
  }
  return matches[0];
}

export function resolveCancelableJob(jobs, idOrPrefix) {
  const matches = matchByPrefix(jobs, idOrPrefix).filter((j) => j.status === 'running' || j.status === 'queued');
  if (matches.length === 0) throw new Error(`no running or queued job matches "${idOrPrefix}"`);
  if (matches.length > 1) {
    throw new Error(`ambiguous job prefix "${idOrPrefix}" matches: ${matches.map((j) => j.id).join(', ')}`);
  }
  return matches[0];
}
