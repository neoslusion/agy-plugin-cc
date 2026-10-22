#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { resolveStateRoot } from './lib/state.mjs';
import { workspaceSlug } from './lib/workspace.mjs';
import { listJobs, readJobFile, mutateJob, isoNow } from './lib/state.mjs';
import { get } from './lib/executors/registry.mjs';
import { loadBrokerSession, isBrokerAlive, ensureBrokerSession, sendBrokerShutdown } from './lib/broker-lifecycle.mjs';

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
  if (env.AGENT_DELEGATION_WORKER === '1') return;
  const envFile = payload.env_file ?? env.CLAUDE_ENV_FILE;
  if (!envFile || !payload.session_id) return;

  const cwd = payload.cwd ?? process.cwd();

  const lines = [
    `AGY_SESSION_ID=${payload.session_id}`,
    `AGY_TRANSCRIPT_PATH=${payload.transcript_path ?? ''}`,
    `CLAUDE_PLUGIN_DATA=${env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'agy-companion')}`,
    ...(payload.permission_mode ? [`AGY_PERMISSION_MODE=${payload.permission_mode}`] : []),
    // Inherit agy approval from the live session: bypassPermissions means the
    // user already granted full autonomy to Claude itself.
    ...(payload.permission_mode === 'bypassPermissions' ? ['AGY_APPROVE_ALL=1'] : []),
  ];

  // Start broker if enabled and not already running
  const useBroker = env.AGY_USE_BROKER !== 'false'; // Default to true
  if (useBroker && cwd) {
    try {
      const broker = loadBrokerSession(cwd);
      if (broker && await isBrokerAlive(broker)) {
        lines.push(`AGY_BROKER_ENDPOINT=${broker.endpoint}`);
      } else {
        // Start new broker
        const newBroker = await ensureBrokerSession(cwd, { env });
        lines.push(`AGY_BROKER_ENDPOINT=${newBroker.endpoint}`);
      }
    } catch (err) {
      // Broker startup failed, continue without it (fall back to direct spawn)
      console.error('Failed to start agy broker:', err.message);
    }
  }

  appendFileSync(envFile, lines.join('\n') + '\n');
}

async function onSessionEnd(payload, env) {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const root = rootFor(payload.cwd, env);
  // Cancel running jobs without signaling a process whose persisted identity is unknown.
  for (const job of listJobs(root)) {
    if (job.sessionId !== sessionId) continue;
    if (job.status !== 'running' && job.status !== 'queued') continue;
    if (job.pid && job.processIdentity?.pid === job.pid) {
      try { await get(job.executor).cancel(job.pid); } catch {}
    }
    mutateJob(root, job.id, current => ({ ...(current ?? job), status: 'cancelled', phase: 'cancelled', cancelledAt: isoNow() }));
  }

  // Shutdown broker if configured to auto-shutdown (default: keep alive for resume)
  const autoShutdown = env.AGY_BROKER_AUTO_SHUTDOWN === 'true';
  if (autoShutdown && payload.cwd) {
    try {
      const broker = loadBrokerSession(payload.cwd);
      if (broker && await isBrokerAlive(broker)) {
        await sendBrokerShutdown(broker.endpoint);
      }
    } catch (err) {
      // Ignore broker shutdown errors
    }
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
