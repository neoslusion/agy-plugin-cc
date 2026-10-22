import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACP_REGISTRY_URL, extractWindowsArchive, findAntigravityRuntime, installAntigravityRuntime, runtimeDirectory, selectWindowsDistribution } from '../scripts/lib/antigravity-runtime.mjs';
import { runAcpSetup } from '../scripts/lib/acp-setup.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-runtime-test-'));
  return { cwd, env: { PATH: '' }, directory: runtimeDirectory(cwd), platform: 'win32', arch: 'x64' };
}
function manifest() {
  return { id: 'antigravity-acp', version: '1.3.0', distribution: { binary: {
    'windows-x86_64': { archive: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip', cmd: './agy_acp_server.exe' },
    'windows-aarch64': { archive: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip', cmd: './agy_acp_server.exe' },
  } } };
}
function downloads(entry = manifest()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    return url === ACP_REGISTRY_URL ? new Response(JSON.stringify(entry)) : new Response('fixture archive');
  };
  const extract = async (archive, destination) => {
    assert.equal(readFileSync(archive, 'utf8'), 'fixture archive');
    const packageDirectory = join(destination, 'release'); mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, 'agy_acp_server.exe'), 'fake server; never executed');
    writeFileSync(join(packageDirectory, 'localharness_external.exe'), 'fake matching helper; never executed');
  };
  return { calls, fetchImpl, extract };
}

test('ACP discovery distinguishes missing, explicit incomplete and complete runtimes', () => {
  const c = fixture();
  assert.equal(findAntigravityRuntime(c).status, 'missing');
  const binary = join(c.cwd, 'agy_acp_server.exe'); writeFileSync(binary, 'fixture');
  const env = { PATH: '', AGY_ACP_BINARY: binary };
  const incomplete = findAntigravityRuntime({ ...c, env });
  assert.equal(incomplete.status, 'invalid');
  assert.deepEqual(incomplete.missing, [join(c.cwd, 'localharness_external.exe')]);
  writeFileSync(join(c.cwd, 'localharness_external.exe'), 'fixture');
  const available = findAntigravityRuntime({ ...c, env });
  assert.equal(available.status, 'ready'); assert.equal(available.source, 'environment');
  assert.equal(available.authenticated, null); assert.equal(available.protocolVerified, false);
  assert.equal(findAntigravityRuntime({ ...c, env: { PATH: c.cwd } }).source, 'path');
});

test('Windows architecture selection rejects unsafe registry downloads and launch commands', () => {
  assert.equal(selectWindowsDistribution(manifest(), 'x64', 'win32').target, 'windows-x86_64');
  assert.equal(selectWindowsDistribution(manifest(), 'arm64', 'win32').target, 'windows-aarch64');
  assert.throws(() => selectWindowsDistribution(manifest(), 'x64', 'linux'), /supports Windows/);
  for (const archive of ['http://dl.google.com/agy-extensions/releases/windows/package.zip', 'https://evil.example/package.zip', 'https://dl.google.com/other/package.zip', 'https://dl.google.com/agy-extensions/releases/windows/package.zip?token=other']) {
    const entry = manifest(); entry.distribution.binary['windows-x86_64'].archive = archive;
    assert.throws(() => selectWindowsDistribution(entry, 'x64', 'win32'), /official Google/);
  }
  const command = manifest(); command.distribution.binary['windows-x86_64'].cmd = '../other.exe';
  assert.throws(() => selectWindowsDistribution(command, 'x64', 'win32'), /launch configuration/);
  const version = manifest(); version.version = '../outside';
  assert.throws(() => selectWindowsDistribution(version, 'x64', 'win32'), /registry entry/);
});

test('managed installation publishes a complete pair, records its hash and avoids repeat downloads', async () => {
  const c = fixture(), fake = downloads();
  const installed = await installAntigravityRuntime({ ...c, ...fake });
  assert.equal(installed.status, 'ready'); assert.equal(installed.installed, true);
  assert.equal(installed.source, 'managed'); assert.equal(installed.version, '1.3.0');
  assert.match(installed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fake.calls.length, 2);
  const metadata = JSON.parse(readFileSync(join(c.directory, 'current.json'), 'utf8'));
  assert.equal(metadata.sha256, installed.sha256);
  assert.ok(existsSync(installed.binary)); assert.ok(existsSync(installed.helper));
  assert.ok(!readdirSync(c.directory).some(name => name.startsWith('.install-') || name === 'install.lock'));
  const again = await installAntigravityRuntime({ ...c, fetchImpl: () => { throw new Error('must not download twice'); } });
  assert.equal(again.installed, false); assert.equal(again.binary, installed.binary);
});

test('missing helper fails installation without publishing partial state or leaving a lock', async () => {
  const c = fixture(), fake = downloads();
  await assert.rejects(() => installAntigravityRuntime({ ...c, ...fake, extract: async (_archive, destination) => {
    mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'agy_acp_server.exe'), 'incomplete');
  } }), /exactly one server and matching/);
  assert.ok(!existsSync(join(c.directory, 'current.json')));
  assert.deepEqual(readdirSync(c.directory), []);
});

test('failed registry and archive requests leave no managed runtime or installation lock', async () => {
  for (const failArchive of [false, true]) {
    const c = fixture();
    const fetchImpl = async url => url === ACP_REGISTRY_URL && failArchive ? new Response(JSON.stringify(manifest())) : new Response('unavailable', { status: 503 });
    await assert.rejects(() => installAntigravityRuntime({ ...c, fetchImpl }), /HTTP 503/);
    assert.deepEqual(readdirSync(c.directory), []);
  }
});

test('explicit incomplete runtime is never silently replaced by managed installation', async () => {
  const c = fixture();
  const env = { PATH: '', AGY_ACP_BINARY: join(c.cwd, 'missing.exe') };
  await assert.rejects(() => installAntigravityRuntime({ ...c, env, fetchImpl: () => { throw new Error('unexpected network'); } }), /fix or unset/);
  assert.ok(!existsSync(c.directory));
});

test('managed discovery refuses metadata that points outside the installation', () => {
  const c = fixture(); mkdirSync(c.directory, { recursive: true });
  writeFileSync(join(c.directory, 'current.json'), JSON.stringify({ binary: '../agy_acp_server.exe', version: '1.3.0' }));
  const result = findAntigravityRuntime(c);
  assert.equal(result.status, 'invalid'); assert.match(result.error, /escapes/);
});

test('concurrent installers cannot launch duplicate downloads', async () => {
  const c = fixture(), fake = downloads();
  let signalStart, release;
  const started = new Promise(resolve => { signalStart = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, options) => {
    if (url === ACP_REGISTRY_URL) { signalStart(); await gate; }
    return fake.fetchImpl(url, options);
  };
  const first = installAntigravityRuntime({ ...c, ...fake, fetchImpl });
  await started;
  try { await assert.rejects(() => installAntigravityRuntime({ ...c, ...fake }), /already locked/); }
  finally { release(); }
  assert.equal((await first).status, 'ready'); assert.equal(fake.calls.length, 2);
});

test('setup check returns honest static availability and workers cannot install', async () => {
  const c = fixture(); const output = [], errors = [];
  const context = { ...c, out: { write: s => output.push(s) }, err: { write: s => errors.push(s) } };
  assert.equal(await runAcpSetup(['--check', '--json'], context), 1);
  assert.equal(JSON.parse(output.pop()).status, 'missing');
  await installAntigravityRuntime({ ...c, ...downloads() });
  assert.equal(await runAcpSetup(['--check', '--json'], context), 0);
  const result = JSON.parse(output.pop());
  assert.equal(result.status, 'ready'); assert.equal(result.protocolVerified, false); assert.equal(result.authenticated, null);
  assert.equal(await runAcpSetup(['--install'], { ...context, env: { ...c.env, AGENT_DELEGATION_WORKER: '1' } }), 1);
  assert.match(errors.join(''), /worker cannot install/);
});

function createWindowsZip(path, names) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$acpFixture = [IO.Compression.ZipFile]::Open($env:AGENT_ACP_TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($acpFixtureName in (ConvertFrom-Json $env:AGENT_ACP_TEST_ENTRIES)) {
    $acpFixtureWriter = [IO.StreamWriter]::new($acpFixture.CreateEntry($acpFixtureName).Open())
    try { $acpFixtureWriter.Write('fixture; never executed') } finally { $acpFixtureWriter.Dispose() }
  }
} finally { $acpFixture.Dispose() }
`;
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, AGENT_ACP_TEST_ZIP: path, AGENT_ACP_TEST_ENTRIES: JSON.stringify(names) }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

test('Windows extractor handles a real zip containing the paired executables', { skip: process.platform !== 'win32' }, async () => {
  const c = fixture(), archive = join(c.cwd, 'valid.zip'), destination = join(c.cwd, 'unpacked');
  createWindowsZip(archive, ['release/agy_acp_server.exe', 'release/localharness_external.exe']);
  await extractWindowsArchive(archive, destination);
  assert.equal(findAntigravityRuntime({ cwd: c.cwd, env: { PATH: '', AGY_ACP_BINARY: join(destination, 'release', 'agy_acp_server.exe') } }).status, 'ready');
});

test('Windows extractor rejects traversal before writing outside the destination', { skip: process.platform !== 'win32' }, async () => {
  const c = fixture(), archive = join(c.cwd, 'unsafe.zip'), destination = join(c.cwd, 'unpacked');
  createWindowsZip(archive, ['../outside.txt']);
  await assert.rejects(() => extractWindowsArchive(archive, destination), /Unsafe path in ACP archive/);
  assert.ok(!existsSync(join(c.cwd, 'outside.txt')));
  assert.ok(!existsSync(destination));
});

test('readiness probes give the slow-starting ACP server a longer default budget than CLI catalogs', async () => {
  const { providerReadiness } = await import('../scripts/lib/provider-readiness.mjs');
  const c = fixture();
  const binary = join(c.cwd, 'agy_acp_server.exe'); writeFileSync(binary, 'fixture');
  writeFileSync(join(c.cwd, 'localharness_external.exe'), 'fixture');
  const seen = {};
  const probes = { agy: async (_, { timeoutMs }) => { seen.acp = timeoutMs; return {}; }, codex: async (_, { timeoutMs }) => { seen.codex = timeoutMs; return {}; } };
  await providerReadiness('agy', 'acp', { cwd: c.cwd, env: { PATH: '', AGY_ACP_BINARY: binary }, probe: true, probes });
  await providerReadiness('codex', 'cli', { cwd: c.cwd, env: { PATH: '', CODEX_BINARY: binary }, probe: true, probes });
  assert.deepEqual(seen, { acp: 60000, codex: 10000 });
  await providerReadiness('agy', 'acp', { cwd: c.cwd, env: { PATH: '', AGY_ACP_BINARY: binary }, probe: true, probes, timeoutMs: 500 });
  assert.equal(seen.acp, 500);
});
