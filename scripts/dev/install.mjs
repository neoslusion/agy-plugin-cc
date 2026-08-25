#!/usr/bin/env node
// Universal installer + doctor for the agy plugin. Works with a stock Claude
// Code install - no personal profiles or launchers required.
//
//   node scripts/dev/install.mjs          register marketplace, install, enable
//   node scripts/dev/install.mjs --check  report status only, change nothing
//
// Names are read from .claude-plugin/*.json at runtime, so plugin/marketplace
// renames cannot leave this script stale.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkOnly = process.argv.includes('--check');

const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const marketplaceManifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const plugin = manifest.name;
const marketplace = marketplaceManifest.name;
const target = `${plugin}@${marketplace}`;
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude');

function claude(args, { inherit = false } = {}) {
    const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
    return spawnSync(bin, args, { stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8', windowsHide: true });
}

function ok(label) { console.log(`  ok      ${label}`); }
function fail(label, hint = '') {
    console.log(`  MISSING ${label}${hint ? `\n          ${hint}` : ''}`);
    process.exitCode = 1;
}

function readJsonSafe(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function installedPlugins() {
    return readJsonSafe(join(configDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
}

function knownMarketplaces() {
    return readJsonSafe(join(configDir, 'plugins', 'known_marketplaces.json')) ?? {};
}

function enabledKeys() {
    const keys = new Set();
    for (const f of ['settings.json', 'settings.local.json']) {
        const s = readJsonSafe(join(configDir, f));
        for (const [k, v] of Object.entries(s?.enabledPlugins ?? {})) if (v) keys.add(k);
    }
    const local = readJsonSafe(join(root, '.claude', 'settings.local.json'));
    for (const [k, v] of Object.entries(local?.enabledPlugins ?? {})) if (v) keys.add(k);
    return keys;
}

if (checkOnly) {
    console.log(`agy plugin doctor (target: ${target})\n`);

    // Marketplace registered?
    if (marketplace in knownMarketplaces()) ok(`marketplace "${marketplace}" registered`);
    else fail(`marketplace "${marketplace}" registered`, `claude plugin marketplace add "${root}"`);

    // Installed + version match?
    const entry = installedPlugins()[target]?.[0];
    if (!entry) fail('plugin installed', `claude plugin install ${target}`);
    else if (entry.version === manifest.version) ok(`plugin installed (${entry.version})`);
    else fail(`plugin version ${entry.version} != manifest ${manifest.version}`, 'reinstall to refresh the cache');

    // Enabled somewhere visible?
    if (enabledKeys().has(target)) ok(`${target} enabled`);
    else fail(`${target} enabled`, `claude plugin enable ${target}`);

    // agy binary present?
    const agy = spawnSync('agy', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (agy.status === 0) ok(`agy CLI ${agy.stdout.trim()}`);
    else fail('agy CLI on PATH', 'https://antigravity.google/download - then run "agy" once to sign in');

    process.exit(process.exitCode ?? 0);
}

console.log(`Installing ${target} from ${root}\n`);

let r = claude(['plugin', 'marketplace', 'add', root]);
if (r.status !== 0 && !/already|exists/i.test(r.stdout + r.stderr)) {
    console.error((r.stderr || r.stdout || '').trim());
    process.exit(r.status ?? 1);
}
console.log(`+ marketplace "${marketplace}" registered`);

r = claude(['plugin', 'install', target]);
if (r.status !== 0 && !/already/i.test(r.stdout + r.stderr)) {
    console.error((r.stderr || r.stdout || '').trim());
    process.exit(r.status ?? 1);
}
console.log(`+ ${target} installed`);

r = claude(['plugin', 'enable', target]);
if (r.status !== 0 && !/already/i.test(r.stdout + r.stderr)) {
    console.error((r.stderr || r.stdout || '').trim());
    process.exit(r.status ?? 1);
}
console.log(`+ ${target} enabled`);

console.log('\nDone. Restart Claude Code sessions, then run /agy:setup.');
