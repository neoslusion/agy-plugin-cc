import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataRoot, migrateLegacyData, resolveDataRoot } from '../scripts/lib/data-root.mjs';
import { makeTempDir } from '../scripts/lib/fs.mjs';

test('default data root is per-user and platform-specific', () => {
  assert.equal(
    defaultDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }),
    join('C:\\Users\\a\\AppData\\Local', 'agent-delegation'),
  );
  assert.equal(
    defaultDataRoot({ platform: 'win32', env: {}, home: 'C:\\Users\\a' }),
    join('C:\\Users\\a', 'AppData', 'Local', 'agent-delegation'),
  );
  assert.equal(
    defaultDataRoot({ platform: 'darwin', env: {}, home: '/Users/a' }),
    join('/Users/a', 'Library', 'Application Support', 'agent-delegation'),
  );
  assert.equal(
    defaultDataRoot({ platform: 'linux', env: {}, home: '/home/a' }),
    join('/home/a', '.local', 'state', 'agent-delegation'),
  );
  assert.equal(
    defaultDataRoot({ platform: 'linux', env: { XDG_STATE_HOME: '/var/state' }, home: '/home/a' }),
    join('/var/state', 'agent-delegation'),
  );
});

test('explicit data directories keep their precedence over the default', () => {
  assert.equal(resolveDataRoot({ AGENT_DELEGATION_DATA: 'a', CLAUDE_PLUGIN_DATA: 'b', PLUGIN_DATA: 'c' }), 'a');
  assert.equal(resolveDataRoot({ CLAUDE_PLUGIN_DATA: 'b', PLUGIN_DATA: 'c' }), 'b');
  assert.equal(resolveDataRoot({ PLUGIN_DATA: 'c' }), 'c');
  assert.equal(resolveDataRoot({ AGENT_DELEGATION_DATA: '', CLAUDE_PLUGIN_DATA: 'b' }), 'b');
});

test('legacy temporary state moves to the new root', () => {
  const tmp = makeTempDir('legacy-data-');
  const legacy = join(tmp, 'agy-companion');
  mkdirSync(join(legacy, 'state', 'project'), { recursive: true });
  writeFileSync(join(legacy, 'state', 'project', 'state.json'), '{"version":1}');
  const root = join(makeTempDir('durable-data-'), 'agent-delegation');
  const migrated = migrateLegacyData(root, { env: {}, tmp });
  assert.deepEqual(migrated, { from: legacy, to: root });
  assert.equal(readFileSync(join(root, 'state', 'project', 'state.json'), 'utf8'), '{"version":1}');
  assert.equal(existsSync(legacy), false);
});

test('legacy migration leaves explicit, existing and absent roots alone', () => {
  const tmp = makeTempDir('legacy-skip-');
  const legacy = join(tmp, 'agy-companion');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'state.json'), 'legacy');

  const explicit = join(makeTempDir('explicit-data-'), 'agent-delegation');
  assert.equal(migrateLegacyData(explicit, { env: { AGENT_DELEGATION_DATA: explicit }, tmp }), null);
  assert.equal(existsSync(explicit), false);
  assert.equal(existsSync(legacy), true);

  const existing = join(makeTempDir('existing-data-'), 'agent-delegation');
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, 'state.json'), 'current');
  assert.equal(migrateLegacyData(existing, { env: {}, tmp }), null);
  assert.equal(readFileSync(join(existing, 'state.json'), 'utf8'), 'current');
  assert.equal(existsSync(legacy), true);

  const emptyTmp = makeTempDir('legacy-absent-');
  assert.equal(migrateLegacyData(join(makeTempDir('no-data-'), 'agent-delegation'), { env: {}, tmp: emptyTmp }), null);
});
