import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { executePlanPhased } from '../scripts/lib/phased-plan.mjs';
import {
  loadBrokerSession,
  clearBrokerSession,
  sendBrokerShutdown,
} from '../scripts/lib/broker-lifecycle.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const FAKE_AGY = join(PLUGIN_ROOT, 'tests', 'fixtures', 'fake-agy', 'fake-agy.mjs');

let savedBinary;
let savedScenario;

// Point execution at the fake binary BEFORE the broker spawns: brokers pass
// their inherited environment down to agy children, so this must be set in
// process.env up front or tests would hit the real (credential-backed) CLI.
function useFakeAgy(scenario) {
  if (savedBinary === undefined) savedBinary = process.env.AGY_BINARY;
  if (savedScenario === undefined) savedScenario = process.env.FAKE_AGY_SCENARIO;
  process.env.AGY_BINARY = FAKE_AGY;
  process.env.FAKE_AGY_SCENARIO = JSON.stringify(scenario);
}

function restoreAgyEnv() {
  if (savedBinary === undefined) delete process.env.AGY_BINARY;
  else process.env.AGY_BINARY = savedBinary;
  if (savedScenario === undefined) delete process.env.FAKE_AGY_SCENARIO;
  else process.env.FAKE_AGY_SCENARIO = savedScenario;
}

// Each test gets its own cwd and plugin-data root so ensureBrokerSession
// starts an isolated broker per test (the fake binary reads its scenario
// from the environment it inherits at broker-spawn time).
function context() {
  const dir = mkdtempSync(join(tmpdir(), 'agyhased-'));
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(tmpdir(), 'agyhased-data-'));
  return {
    cwd: dir,
    restore: () => {
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
    },
  };
}

async function stopBroker(cwd) {
  const session = loadBrokerSession(cwd);
  if (session) {
    try {
      await sendBrokerShutdown(session.endpoint);
    } catch {
      // already gone
    }
  }
  clearBrokerSession(cwd);
}

const TWO_PHASES = [
  { name: 'Phase 1: Greet', prompt: 'Say "Hello from Phase 1" in one sentence', exitCriteria: 'Response contains "Hello"' },
  { name: 'Phase 2: Confirm', prompt: 'Say "Received from Phase 1, now in Phase 2" in one sentence', exitCriteria: 'Response contains "Phase 2"' },
];

test('executePlanPhased runs all phases through the broker with synthesis gates', async () => {
  useFakeAgy({});
  const ctx = context();
  try {
    const progress = [];
    const syntheses = [];
    const result = await executePlanPhased({
      phases: TWO_PHASES,
      cwd: ctx.cwd,
      onProgress: (e) => progress.push(e),
      onPhaseComplete: async (phase, phaseResult, gate) => {
        syntheses.push({ phase: gate.phaseNumber, status: phaseResult.status });
        return { abort: false, insights: `Phase ${gate.phaseNumber} looked good` };
      },
      sharedContext: {},
    });

    assert.equal(result.aborted, false);
    assert.equal(result.completed, 2);
    assert.equal(result.results.length, 2);
    for (const r of result.results) {
      assert.equal(r.status, 'completed');
      assert.match(r.response, /PONG/);
    }
    assert.deepEqual(syntheses.map((s) => s.phase), [1, 2]);
    const kinds = progress.map((e) => e.type);
    assert.ok(kinds.includes('phase-start'));
    assert.ok(kinds.includes('phase-complete'));
  } finally {
    ctx.restore();
    restoreAgyEnv();
    await stopBroker(ctx.cwd);
  }
});

test('executePlanPhased aborts when the orchestrator says so at a synthesis gate', async () => {
  useFakeAgy({});
  const ctx = context();
  try {
    const result = await executePlanPhased({
      phases: TWO_PHASES,
      cwd: ctx.cwd,
      onPhaseComplete: async () => ({ abort: true, reason: 'exit criteria not met' }),
    });

    assert.equal(result.aborted, true);
    assert.equal(result.completed, 1);
    assert.equal(result.reason, 'exit criteria not met');
    assert.equal(result.results.length, 1);
  } finally {
    ctx.restore();
    restoreAgyEnv();
    await stopBroker(ctx.cwd);
  }
});

test('executePlanPhased surfaces failed phases to the orchestrator', async () => {
  useFakeAgy({ status: 'ERROR', error: 'invalid model selection' });
  const ctx = context();
  try {
    let sawFailure = false;
    const result = await executePlanPhased({
      phases: [TWO_PHASES[0]],
      cwd: ctx.cwd,
      onPhaseComplete: async (_phase, phaseResult) => {
        if (phaseResult.status !== 'completed') sawFailure = true;
        return { abort: true, reason: 'phase failed' };
      },
    });

    assert.equal(sawFailure, true, 'orchestrator should see the non-completed phase');
    assert.equal(result.aborted, true);
    assert.notEqual(result.results[0].status, 'completed');
  } finally {
    ctx.restore();
    restoreAgyEnv();
    await stopBroker(ctx.cwd);
  }
});
