#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { resolveStateRoot } from './lib/state.mjs';
import { workspaceSlug } from './lib/workspace.mjs';
import { listJobs, readJobFile, upsertJob, isoNow } from './lib/state.mjs';
import { get } from './lib/executors/registry.mjs';

function readPayload() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      try {
        process.stdin.pause();
        process.stdin.removeAllListeners();
      } catch {}
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    const fallback = setTimeout(finish, 2000);
  });
}

function rootFor(cwd, env) {
  const dataRoot = env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'agy-companion');
  return resolveStateRoot(dataRoot, workspaceSlug(cwd ?? process.cwd()));
}

async function onSessionStart(payload, env) {
  const envFile = payload.env_file ?? env.CLAUDE_ENV_FILE;
  if (!envFile || !payload.session_id) return;
  const lines = [
    `AGY_SESSION_ID=${payload.session_id}`,
    `AGY_TRANSCRIPT_PATH=${payload.transcript_path ?? ''}`,
    `CLAUDE_PLUGIN_DATA=${env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'agy-companion')}`,
  ];
  appendFileSync(envFile, lines.join('\n') + '\n');
}

async function onSessionEnd(payload, env) {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const root = rootFor(payload.cwd, env);
  const executor = get('agy');
  for (const job of listJobs(root)) {
    if (job.sessionId !== sessionId) continue;
    if (job.status !== 'running' && job.status !== 'queued') continue;
    try {
      await executor.cancel(job.pid);
    } catch {}
    upsertJob(root, { ...readJobFile(root, job.id) ?? job, status: 'cancelled', phase: 'cancelled', cancelledAt: isoNow() });
  }
}

const event = process.argv[2];
const payload = await readPayload();
const env = process.env;
if (event === 'SessionStart') await onSessionStart(payload, env);
else if (event === 'SessionEnd') await onSessionEnd(payload, env);
process.exit(0);

// Watchdog: force-exit well under the 5s hook timeout if anything (e.g. an
// inherited TTY stdin) keeps the event loop alive.
setTimeout(() => process.exit(0), 3000).unref();
