import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const host of ['codex', 'claude']) {
  test(`install package into isolated ${host} configuration`, { skip: process.env.AGENT_INSTALL_TESTS !== '1', timeout: 300_000 }, () => {
    const config = mkdtempSync(join(tmpdir(), `delegation-install-${host}-`));
    const installer = join(import.meta.dirname, '..', 'scripts', 'dev', 'install-delegation.mjs');
    const env = { ...process.env, CODEX_HOME: config, CLAUDE_CONFIG_DIR: config };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [installer, host], { env, encoding: 'utf8', windowsHide: true, timeout: 140_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  });
}
