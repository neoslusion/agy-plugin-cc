import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, ensureDir } from './fs.mjs';
import { isoNow } from './state.mjs';
import { artifactId, withArtifactLock } from './artifact-store.mjs';

const directory = (root, id) => join(root, 'events', artifactId(id));
const IMPORTANT = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.input_required', 'permission.denied', 'monitor.result']);

export function readTaskEvents(root, id, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer');
  let names;
  try { names = readdirSync(directory(root, id)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^\d+\.json$/.test(name) && Number(name.slice(0, -5)) > after)
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    .map(name => JSON.parse(readFileSync(join(directory(root, id), name), 'utf8')));
}

export function appendTaskEvent(root, id, type, data = {}) {
  if (!/^[a-z]+\.[a-z_]+$/.test(type)) throw new Error('Invalid task event type');
  // Keep provider token streams out of durable orchestration events.
  const encoded = JSON.stringify(data);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('Task event exceeds 64 KiB');
  return withArtifactLock(directory(root, id), () => {
    const names = readdirSync(directory(root, id)).filter(name => /^\d+\.json$/.test(name));
    const sequence = Math.max(0, ...names.map(name => Number(name.slice(0, -5)))) + 1;
    const event = { version: 1, taskId: id, sequence, type, createdAt: isoNow(), data };
    writeJsonAtomic(join(directory(root, id), `${sequence}.json`), event);
    return event;
  });
}

export async function waitTaskEvents(root, id, after = 0, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const events = readTaskEvents(root, id, after);
    if (events.length || Date.now() >= deadline) return { events, cursor: events.at(-1)?.sequence ?? after, waitTimedOut: !events.length };
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}

export function pendingNotifications(root, jobs, sessionId, acknowledge = false, limit = 16) {
  if (!sessionId) throw new Error('Notification delivery requires a parent session ID');
  const owner = createHash('sha256').update(sessionId ?? 'unscoped').digest('hex');
  const receipts = join(root, 'deliveries', owner);
  ensureDir(receipts);
  return withArtifactLock(receipts, () => {
    const notifications = [];
    const supervisors = new Set(jobs.filter(job => job.kind === 'run' && job.sessionId === sessionId).map(job => job.id));
    for (const job of jobs.filter(job => job.sessionId === sessionId || supervisors.has(job.supervisorId))) {
      if (notifications.length >= limit) break;
      const receipt = join(receipts, `${artifactId(job.id)}.json`);
      let after = 0;
      try { after = JSON.parse(readFileSync(receipt, 'utf8')).cursor; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const events = readTaskEvents(root, job.id, after);
      let cursor = after;
      for (const event of events) {
        if (IMPORTANT.has(event.type)) {
          if (notifications.length >= limit) break;
          notifications.push({ ...event, role: job.role, executor: job.executor, supervisorId: job.supervisorId ?? null, context: job.context ?? null });
        }
        cursor = event.sequence;
      }
      if (acknowledge && cursor > after) writeJsonAtomic(receipt, { cursor, acknowledgedAt: isoNow() });
    }
    return notifications;
  });
}

export function acknowledgeNotifications(root, sessionId, notifications) {
  if (!sessionId) throw new Error('Notification delivery requires a parent session ID');
  const owner = createHash('sha256').update(sessionId).digest('hex');
  const receipts = join(root, 'deliveries', owner);
  ensureDir(receipts);
  return withArtifactLock(receipts, () => {
    for (const id of new Set(notifications.map(event => event.taskId))) {
      const receipt = join(receipts, `${artifactId(id)}.json`);
      let previous = 0;
      try { previous = JSON.parse(readFileSync(receipt, 'utf8')).cursor; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const cursor = Math.max(previous, ...notifications.filter(event => event.taskId === id).map(event => event.sequence));
      writeJsonAtomic(receipt, { cursor, acknowledgedAt: isoNow() });
    }
  });
}
