import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../lib/process.mjs';
import { packageDelegation, ROOT, PLUGIN } from './package-delegation.mjs';

function run(binary, args, tolerate) {
  const result = runCommand(binary, args, { timeoutMs: 120_000 });
  if (result.code !== 0 && !tolerate?.test(result.stdout + result.stderr)) throw new Error(`${binary} ${args.join(' ')} failed: ${result.error?.message ?? (result.stderr || result.stdout)}`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

try {
  const host = process.argv[2];
  if (!['codex', 'claude', 'both'].includes(host)) throw new Error('Usage: node scripts/dev/install-delegation.mjs codex|claude|both');
  packageDelegation();
  if (host === 'codex' || host === 'both') {
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    run('codex', ['plugin', 'marketplace', 'add', ROOT]);
    run('codex', ['plugin', 'add', `agent-delegation@${marketplace.name}`]);
  }
  if (host === 'claude' || host === 'both') {
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const registered = runCommand('claude', ['plugin', 'marketplace', 'add', ROOT], { timeoutMs: 120_000 });
    if (registered.code !== 0 && !/already|exists/i.test(registered.stdout + registered.stderr)) throw new Error(registered.error?.message ?? registered.stderr);
    run('claude', ['plugin', 'install', `agent-delegation@${marketplace.name}`]);
    run('claude', ['plugin', 'enable', `agent-delegation@${marketplace.name}`], /already enabled/i);
  }
  console.log(`Installed agent-delegation for ${host}. Start a new host session. Source: ${PLUGIN}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
