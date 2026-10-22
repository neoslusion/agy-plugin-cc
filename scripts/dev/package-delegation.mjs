import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const PLUGIN = join(ROOT, 'plugins', 'agent-delegation');

export function packageDelegation() {
  for (const dir of ['scripts', 'prompts', 'schemas']) rmSync(join(PLUGIN, dir), { recursive: true, force: true });
  mkdirSync(join(PLUGIN, 'scripts'), { recursive: true });
  // Bundle the existing runtime as files so both hosts' cache copies are self-contained.
  for (const file of readdirSync(join(ROOT, 'scripts')).filter(f => f.endsWith('.mjs'))) {
    cpSync(join(ROOT, 'scripts', file), join(PLUGIN, 'scripts', file));
  }
  for (const dir of ['lib']) cpSync(join(ROOT, 'scripts', dir), join(PLUGIN, 'scripts', dir), { recursive: true });
  for (const dir of ['prompts', 'schemas']) cpSync(join(ROOT, dir), join(PLUGIN, dir), { recursive: true });
  const sdk = join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const vendor = join(PLUGIN, 'scripts', 'vendor');
  mkdirSync(vendor, { recursive: true });
  cpSync(join(sdk, 'sdk.mjs'), join(vendor, 'claude-agent-sdk.mjs'));
  cpSync(join(sdk, 'LICENSE.md'), join(vendor, 'claude-agent-sdk-LICENSE.md'));
  cpSync(join(sdk, 'package.json'), join(vendor, 'claude-agent-sdk-package.json'));
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'agent-delegation') throw new Error('Unexpected plugin name');
  return PLUGIN;
}

if (import.meta.main) console.log(`Packaged ${packageDelegation()}`);
