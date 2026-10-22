import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateJobId, isoNow } from './state.mjs';
import { ensureDir, writeJsonAtomic } from './fs.mjs';
import { artifactId } from './artifact-store.mjs';

const directory = (root, id) => join(root, 'controls', artifactId(id));

export function queueTaskControl(root, job, sessionId, type, message = null) {
  if (job.sessionId !== sessionId) throw new Error('Task belongs to a different parent session');
  if (!['queued', 'running'].includes(job.status)) throw new Error('Task is no longer active');
  if (!['steer', 'interrupt'].includes(type)) throw new Error('Unknown task control');
  if (type === 'steer' && !job.capabilities?.steering) throw new Error('This integration does not support live steering');
  if (type === 'interrupt' && !job.capabilities?.interrupt) throw new Error('This integration does not support graceful interruption; use cancel');
  if (type === 'steer' && (typeof message !== 'string' || !message.trim() || message.length > 32768)) throw new Error('Steering requires a message of at most 32768 characters');
  const request = { version: 1, id: generateJobId('control'), taskId: job.id, type, message, createdAt: isoNow() };
  ensureDir(directory(root, job.id));
  writeJsonAtomic(join(directory(root, job.id), `${request.id}.json`), request);
  return request;
}

export function watchTaskControls(root, taskId, handlers, onEvent = () => {}) {
  if (!root || !taskId) return () => {};
  const dir = directory(root, taskId);
  ensureDir(dir);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const name of readdirSync(dir).filter(name => /^control-[a-z0-9-]+\.json$/.test(name)).sort()) {
        const receipt = join(dir, `${name}.receipt`);
        try { readFileSync(receipt); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const request = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        let result;
        try {
          if (!handlers[request.type]) throw new Error(`${request.type} is unavailable for this active task`);
          await handlers[request.type](request.message);
          result = { status: 'accepted' };
        } catch (error) { result = { status: 'failed', error: error.message }; }
        writeJsonAtomic(receipt, { id: request.id, ...result, completedAt: isoNow() });
        onEvent({ type: 'control.completed', data: { controlId: request.id, operation: request.type, ...result } });
      }
    } catch (error) { onEvent({ type: 'control.failed', data: { error: error.message } }); }
    finally { busy = false; }
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}
