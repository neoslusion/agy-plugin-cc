#!/usr/bin/env node
import { readJobFile, mutateJob } from './lib/state.mjs';
import { artifactId } from './lib/artifact-store.mjs';
import { runForeground } from './agy-companion.mjs';
import { appendTaskEvent } from './lib/task-events.mjs';

if (import.meta.main) {
  const [root, rawId] = process.argv.slice(2);
  const id = artifactId(rawId);
  let job;
  for (let n = 0; n < 40; n++) {
    job = readJobFile(root, id);
    if (job) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!job) throw new Error('Delegated task record was not published');
  if (job.status === 'queued') {
    job = mutateJob(root, id, current => {
      if (current.pid !== process.pid) throw new Error('Task worker does not own this dispatch');
      return current;
    });
    if (job.status === 'queued') {
      try { process.exitCode = await runForeground({ root, cwd: job.workspaceRoot, env: process.env, legacy: false, out: process.stdout, err: process.stderr }, job, job.execution); }
      catch (error) {
        const failed = mutateJob(root, id, current => current.status === 'cancelled' ? current : { ...current, status: 'failed', phase: 'failed', errorMessage: error.message, completedAt: new Date().toISOString() });
        if (failed.status === 'failed') appendTaskEvent(root, id, 'task.failed', { error: String(error.message).slice(0, 8192) });
        process.exitCode = 1;
      }
    }
  }
}
