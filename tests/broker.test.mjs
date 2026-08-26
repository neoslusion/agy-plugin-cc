import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createBrokerEndpoint } from '../scripts/lib/broker-endpoint.mjs';
import { waitForBrokerEndpoint, sendBrokerShutdown } from '../scripts/lib/broker-lifecycle.mjs';
import { AgyBrokerClient } from '../scripts/lib/rpc-client.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const BROKER_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'agy-broker.mjs');
const FAKE_AGY = join(PLUGIN_ROOT, 'tests', 'fixtures', 'fake-agy', 'fake-agy.mjs');

// Starts a real broker process pointed at the fake agy binary so the suite
// runs fully offline. The scenario JSON reaches fake-agy through the
// broker's environment (fake-agy inherits it as the broker's child).
async function startBroker(scenario = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), 'agybroker-test-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybroker-cwd-'));
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawn(process.execPath, [BROKER_SCRIPT, 'serve', '--endpoint', endpoint], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      AGY_BINARY: FAKE_AGY,
      FAKE_AGY_SCENARIO: JSON.stringify(scenario),
    },
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  const ready = await waitForBrokerEndpoint(endpoint, 5000);
  if (!ready) {
    child.kill();
    throw new Error(`broker did not become ready. Output:\n${output}`);
  }

  return {
    endpoint,
    stop: async () => {
      try {
        await sendBrokerShutdown(endpoint);
      } catch {
        // already gone
      }
      if (!child.killed) child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    },
  };
}

test('two concurrent clients both complete (fan-out must not serialize)', async () => {
  const DELAY_MS = 500;
  const broker = await startBroker({ delayMs: DELAY_MS });
  try {
    const clientA = new AgyBrokerClient(broker.endpoint);
    const clientB = new AgyBrokerClient(broker.endpoint);
    await clientA.connect();
    await clientB.connect();

    const args = ['-p', 'say hi', '--output-format', 'text'];
    const t0 = Date.now();
    // Fire both requests back-to-back so they are genuinely in flight together.
    const [startA, startB] = [Date.now(), Date.now()];
    const [resA, resB] = await Promise.all([
      clientA.request('agy/run', { args }),
      clientB.request('agy/run', { args }),
    ]);
    const [endA, endB] = [Date.now(), Date.now()];

    assert.equal(resA.status, 'completed');
    assert.equal(resA.exitCode, 0);
    assert.equal(resA.stdout, 'PONG\n');
    assert.equal(resB.status, 'completed');
    assert.equal(resB.exitCode, 0);
    assert.equal(resB.stdout, 'PONG\n');

    // If the broker serialized runs, the second would start no earlier than
    // the first's completion and the windows could not overlap.
    const overlapStart = Math.max(startA - t0, startB - t0);
    const overlapEnd = Math.min(endA - t0, endB - t0);
    assert.ok(
      overlapStart < overlapEnd,
      `expected overlapping execution windows, got [${startA - t0},${endA - t0}] vs [${startB - t0},${endB - t0}]`,
    );

    await clientA.close();
    await clientB.close();
  } finally {
    await broker.stop();
  }
});

test('stream-json events are forwarded as notifications to the requesting client', async () => {
  const broker = await startBroker({});
  try {
    const client = new AgyBrokerClient(broker.endpoint);
    await client.connect();

    const notifications = [];
    client.setNotificationHandler((msg) => {
      if (msg.method === 'agy/notification') notifications.push(msg.params);
    });

    const result = await client.request('agy/run', {
      args: ['-p', 'hello', '--output-format', 'stream-json'],
    });

    assert.equal(result.status, 'completed');
    const events = notifications.map((n) => n.event);
    assert.ok(events.includes('init'), `expected init event, got: ${events.join(',')}`);
    assert.ok(events.includes('result'), `expected result event, got: ${events.join(',')}`);

    await client.close();
  } finally {
    await broker.stop();
  }
});

test('failing agy run reports status failed instead of throwing protocol errors', async () => {
  const broker = await startBroker({ status: 'ERROR', error: 'invalid model selection' });
  try {
    const client = new AgyBrokerClient(broker.endpoint);
    await client.connect();

    const result = await client.request('agy/run', {
      args: ['-p', 'broken', '--output-format', 'text'],
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);

    await client.close();
  } finally {
    await broker.stop();
  }
});

test('unknown methods get a JSON-RPC method-not-found error', async () => {
  const broker = await startBroker({});
  try {
    const client = new AgyBrokerClient(broker.endpoint);
    await client.connect();

    await assert.rejects(
      () => client.request('agy/nope', {}),
      /Method not found/,
    );

    await client.close();
  } finally {
    await broker.stop();
  }
});
