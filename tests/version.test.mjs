import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionMismatches } from '../scripts/dev/check-versions.mjs';

test('package, lockfile, host manifests and changelog share one version', () => {
  assert.deepEqual(versionMismatches(), []);
});
