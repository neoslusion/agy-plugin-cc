import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { resolveStateRoot, listJobs } from '../scripts/lib/state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';
import { runMain } from '../scripts/agy-companion.mjs';
import { binaryAvailable } from '../scripts/lib/process.mjs';

// Integration tests require the real agy binary AND working credentials.
// They self-skip (with a clear message) when either is missing, so `npm test`
// stays fully green offline.

function agyAvailable() {
  if (!binaryAvailable('agy')) return 'agy binary not found on PATH';
  return false;
}

test('setup reports ready against the real agy binary', { skip: agyAvailable() }, async () => {
  const dir = makeTempDir('integ-');
  const outLines = [];
  const ctx = {
    cwd: dir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, AGY_SESSION_ID: 'integ' },
    out: { write: (s) => outLines.push(s) },
    err: { write: () => {} },
  };
  const code = await runMain(['setup', '--json'], ctx);
  const report = JSON.parse(outLines[0]);
  if (!report.ready) {
    test.skip('agy not authenticated — skipping real-binary integration');
    return;
  }
  assert.equal(code, 0);
  assert.equal(report.binary, true);
});

test('task runs end-to-end against the real agy binary', { skip: agyAvailable() }, async () => {
  const dir = makeTempDir('integ-');
  const root = resolveStateRoot(dir, workspaceSlug(dir));
  const outLines = [];
  const errLines = [];
  const ctx = {
    cwd: dir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, AGY_SESSION_ID: 'integ' },
    out: { write: (s) => outLines.push(s) },
    err: { write: (s) => errLines.push(s) },
  };
  const code = await runMain(['task', 'Reply with exactly PONG', '--wait', '--timeout-ms', '120000'], ctx);
  assert.equal(code, 0);
  assert.equal(outLines[0], 'PONG\n');
  const jobs = listJobs(root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
  assert.ok(jobs[0].conversationId);
  assert.ok(errLines.length === 0, `unexpected stderr: ${errLines.join('\n')}`);
});
