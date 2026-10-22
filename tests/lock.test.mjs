import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withLock, breakAbandonedLock } from '../scripts/lib/lock.mjs';
import { withArtifactLock } from '../scripts/lib/artifact-store.mjs';
import { appendTaskEvent, readTaskEvents } from '../scripts/lib/task-events.mjs';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('a lock left by a dead holder is broken instead of wedging every later caller', () => {
  const dir = tempDir('lock-dead-');
  const path = join(dir, '.lock');
  // A pid that cannot be running: the highest pid Windows can hand out.
  writeFileSync(path, '4194303');
  assert.equal(breakAbandonedLock(path), true);
  assert.equal(existsSync(path), false);
  assert.equal(withLock(path, () => 'acquired'), 'acquired');
});

test('a lock held by a live process is never broken', () => {
  const dir = tempDir('lock-live-');
  const path = join(dir, '.lock');
  writeFileSync(path, String(process.pid));
  assert.equal(breakAbandonedLock(path), false);
  assert.equal(existsSync(path), true);
});

test('a lock with no identifiable holder is kept until it is stale', () => {
  const dir = tempDir('lock-unknown-');
  const path = join(dir, '.lock');
  writeFileSync(path, '');
  assert.equal(breakAbandonedLock(path), false);
  assert.equal(existsSync(path), true);
});

test('the lock is released when the action throws', () => {
  const dir = tempDir('lock-throw-');
  const path = join(dir, '.lock');
  assert.throws(() => withLock(path, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(path), false);
  assert.equal(withLock(path, () => 'recovered'), 'recovered');
});

test('concurrent event writers keep an ordered log', async () => {
  const root = tempDir('lock-events-');
  const url = pathToFileURL(join(import.meta.dirname, '../scripts/lib/task-events.mjs')).href;
  const run = index => new Promise((resolve, reject) => {
    const source = `import {appendTaskEvent} from ${JSON.stringify(url)}; for(let n=0;n<12;n++)appendTaskEvent(process.argv[1],'shared-task','tool.started',{writer:${index},n});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => error += chunk);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([0, 1, 2, 3].map(run));
  const events = readTaskEvents(root, 'shared-task');
  assert.equal(events.length, 48);
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 48 }, (_, n) => n + 1));
  const sequences = new Set(events.map(event => event.sequence));
  assert.equal(sequences.size, 48);
});

test('a live holder is never locked out by a waiter that suspects a stale lock', async () => {
  const dir = tempDir('lock-holder-');
  const path = join(dir, '.lock');
  const url = pathToFileURL(join(import.meta.dirname, '../scripts/lib/lock.mjs')).href;
  const source = `import {withLock} from ${JSON.stringify(url)}; withLock(process.argv[1], () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  // The child holds the lock while it runs. Repeatedly suspecting it as
  // abandoned must not remove it, or a second writer would enter the
  // critical section at the same time.
  for (let n = 0; n < 200; n++) breakAbandonedLock(path);
  assert.equal(existsSync(path), true, 'the live holder lost its lock');
  const exited = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exited, 0);
  assert.equal(existsSync(path), false, 'the lock was not released on exit');
});

test('the artifact lock serializes concurrent writers in one process', () => {
  const dir = tempDir('lock-serial-');
  const order = [];
  for (let n = 0; n < 5; n++) withArtifactLock(dir, () => { order.push(n); });
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});
