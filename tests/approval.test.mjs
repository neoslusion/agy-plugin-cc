import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { claudeBypassConfigured, envSaysApproveAll, resolveApproveAll } from '../scripts/lib/approval.mjs';

function writeSettings(root, file, defaultMode) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', file),
    JSON.stringify(defaultMode ? { permissions: { defaultMode } } : {})
  );
}

test('explicit flag always wins', () => {
  assert.equal(resolveApproveAll({ explicit: true, env: {} }), true);
  assert.equal(resolveApproveAll({ explicit: false, env: { AGY_APPROVE_ALL: '1' }, cwd: makeTempDir('appr-') }), false);
  assert.equal(resolveApproveAll({ explicit: false, config: true, cwd: makeTempDir('appr-') }), false);
});

test('plugin config grants approval without flags or bypass sessions', () => {
  const cwd = makeTempDir('appr-cfg-');
  assert.equal(resolveApproveAll({ config: true, cwd, env: {} }), true);
});

test('envSaysApproveAll accepts forgiving truthy values', () => {
  assert.equal(envSaysApproveAll({ AGY_APPROVE_ALL: '1' }), true);
  assert.equal(envSaysApproveAll({ AGY_APPROVE_ALL: 'true' }), true);
  assert.equal(envSaysApproveAll({ AGY_APPROVE_ALL: 'yes' }), true);
  assert.equal(envSaysApproveAll({ AGY_APPROVE_ALL: '0' }), false);
  assert.equal(envSaysApproveAll({}), false);
});

test('live session mode (AGY_APPROVE_ALL) grants approval without the flag', () => {
  const cwd = makeTempDir('appr-env-');
  assert.equal(resolveApproveAll({ explicit: undefined, env: { AGY_APPROVE_ALL: '1' }, cwd }), true);
});

test('settings files with bypassPermissions grant approval; acceptEdits does not', () => {
  const bypass = makeTempDir('appr-bypass-');
  writeSettings(bypass, 'settings.local.json', 'bypassPermissions');
  assert.equal(claudeBypassConfigured({ cwd: bypass, env: {} }), true);
  assert.equal(resolveApproveAll({ cwd: bypass, env: {} }), true);

  const acceptEdits = makeTempDir('appr-edits-');
  writeSettings(acceptEdits, 'settings.json', 'acceptEdits');
  assert.equal(claudeBypassConfigured({ cwd: acceptEdits, env: {} }), false);
  assert.equal(resolveApproveAll({ cwd: acceptEdits, env: {} }), false);

  const plain = makeTempDir('appr-plain-');
  assert.equal(resolveApproveAll({ cwd: plain, env: {} }), false);
});

test('user-level CLAUDE_CONFIG_DIR settings are honored', () => {
  const cfg = makeTempDir('appr-cfg-');
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  const cwd = makeTempDir('appr-cfg-cwd-');
  assert.equal(claudeBypassConfigured({ cwd, env: { CLAUDE_CONFIG_DIR: cfg } }), true);
  assert.equal(resolveApproveAll({ cwd, env: { CLAUDE_CONFIG_DIR: cfg } }), true);
});

test('malformed or unrelated settings never crash resolution', () => {
  const bad = makeTempDir('appr-bad-');
  mkdirSync(join(bad, '.claude'), { recursive: true });
  writeFileSync(join(bad, '.claude', 'settings.json'), '{ not json');
  assert.equal(claudeBypassConfigured({ cwd: bad, env: {} }), false);
  assert.equal(resolveApproveAll({ cwd: bad, env: {} }), false);
});
