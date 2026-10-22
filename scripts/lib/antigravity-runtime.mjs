import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const ACP_REGISTRY_URL = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json';
const SERVER = 'agy_acp_server.exe';
const HELPER = 'localharness_external.exe';
const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;
const isFile = path => { try { const info = statSync(path); return info.isFile() && info.size > 0; } catch { return false; } };
export const runtimeDirectory = cwd => resolve(cwd, '.agent-delegation-runtime', 'antigravity-acp');
const contained = (base, target) => { const part = relative(base, target); return part && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); };

function inspect(binary, source, version = null) {
  const helper = join(dirname(binary), process.platform === 'win32' || binary.endsWith('.exe') ? HELPER : 'localharness_external');
  return { status: isFile(binary) && isFile(helper) ? 'ready' : 'invalid', binary, helper, source, version,
    missing: [binary, helper].filter(path => !isFile(path)), authenticated: null, protocolVerified: false };
}

function fromPath(name, env) {
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry.replace(/^"|"$/g, ''), name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export function findAntigravityRuntime({ cwd = process.cwd(), env = process.env, directory = runtimeDirectory(cwd) } = {}) {
  if (env.AGY_ACP_BINARY) {
    const value = env.AGY_ACP_BINARY;
    const binary = isAbsolute(value) || /[\\/]/.test(value) ? resolve(cwd, value) : fromPath(value, env) ?? resolve(cwd, value);
    return inspect(binary, 'environment');
  }
  const root = resolve(directory), marker = join(root, 'current.json');
  if (existsSync(marker)) {
    try {
      const metadata = JSON.parse(readFileSync(marker, 'utf8'));
      if (typeof metadata.binary !== 'string' || isAbsolute(metadata.binary)) throw new Error('Invalid managed binary path');
      const binary = resolve(root, metadata.binary);
      if (!contained(root, binary) || ![SERVER, 'agy_acp_server.par'].includes(binary.split(/[\\/]/).at(-1))) throw new Error('Managed binary path escapes its runtime directory');
      return inspect(binary, 'managed', metadata.version ?? null);
    } catch (error) { return { status: 'invalid', source: 'managed', error: error.message, binary: null, authenticated: null, protocolVerified: false }; }
  }
  for (const name of [SERVER, 'agy_acp_server.par']) {
    const binary = fromPath(name, env);
    if (binary) return inspect(binary, 'path');
  }
  return { status: 'missing', binary: null, source: null, authenticated: null, protocolVerified: false };
}

export function selectWindowsDistribution(manifest, arch = process.arch, platform = process.platform) {
  if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Managed ACP download currently supports Windows x64 and ARM64; configure AGY_ACP_BINARY for other platforms');
  if (manifest?.id !== 'antigravity-acp' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version ?? '')) throw new Error('Invalid official ACP registry entry');
  const target = `windows-${arch === 'x64' ? 'x86_64' : 'aarch64'}`;
  const distribution = manifest.distribution?.binary?.[target];
  if (!distribution || distribution.cmd !== `./${SERVER}` || (distribution.args?.length ?? 0) !== 0) throw new Error(`Unsupported ACP launch configuration for ${target}`);
  const archive = new URL(distribution.archive);
  if (archive.protocol !== 'https:' || archive.hostname !== 'dl.google.com' || archive.port || archive.username || archive.password || !archive.pathname.startsWith('/agy-extensions/releases/windows/') || !archive.pathname.endsWith('.zip') || archive.search || archive.hash) throw new Error('ACP archive must be an official Google Windows download');
  return { version: manifest.version, target, archive: archive.href, server: SERVER, helper: HELPER };
}

const EXTRACT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$acpDestination = [IO.Path]::GetFullPath($env:AGENT_ACP_EXTRACT_DIRECTORY).TrimEnd('\')
$acpArchive = [IO.Compression.ZipFile]::OpenRead($env:AGENT_ACP_ARCHIVE_FILE)
try {
  $acpTotalBytes = [long]0
  foreach ($acpEntry in $acpArchive.Entries) {
    $acpName = $acpEntry.FullName
    if ($acpName -match '^[\/]' -or $acpName -match '[:\x00-\x1f]' -or ($acpName -split '[\/]' | Where-Object { $_ -eq '..' -or ($_ -ne '.' -and $_ -match '[. ]$') -or $_ -match '(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)' })) { throw 'Unsafe path in ACP archive' }
    if ((($acpEntry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or ($acpEntry.ExternalAttributes -band 0x400) -ne 0) { throw 'Links are not allowed in ACP archives' }
    $acpTarget = [IO.Path]::GetFullPath([IO.Path]::Combine($acpDestination, $acpName))
    if ($acpTarget -ne $acpDestination -and -not $acpTarget.StartsWith($acpDestination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ACP archive path escapes its installation' }
    $acpTotalBytes += $acpEntry.Length
    if ($acpTotalBytes -gt 17179869184) { throw 'ACP archive expands beyond 16 GiB' }
  }
} finally { $acpArchive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($env:AGENT_ACP_ARCHIVE_FILE, $acpDestination)
`;

export async function extractWindowsArchive(archive, destination) {
  if (process.platform !== 'win32') throw new Error('Windows PowerShell is required to extract this runtime');
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolveExit, reject) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(EXTRACT_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, AGENT_ACP_ARCHIVE_FILE: archive, AGENT_ACP_EXTRACT_DIRECTORY: destination },
      timeout: 600000,
    });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveExit() : reject(new Error(`ACP archive extraction failed (${code}): ${error.trim()}`)));
  });
}

function findPair(directory) {
  const matches = [];
  function walk(path) {
    const entries = readdirSync(path, { withFileTypes: true });
    if (entries.some(entry => entry.name === SERVER && entry.isFile()) && entries.some(entry => entry.name === HELPER && entry.isFile())) matches.push(join(path, SERVER));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('ACP extraction contains a link');
      if (entry.isDirectory()) walk(join(path, entry.name));
    }
  }
  walk(directory);
  if (matches.length !== 1) throw new Error('ACP archive must contain exactly one server and matching localharness_external.exe pair');
  return matches[0];
}

export async function installAntigravityRuntime({ cwd = process.cwd(), env = process.env, directory = runtimeDirectory(cwd), arch = process.arch, platform = process.platform, fetchImpl = fetch, extract = extractWindowsArchive } = {}) {
  const root = resolve(directory);
  const existing = findAntigravityRuntime({ cwd, env, directory: root });
  if (existing.status === 'ready') return { ...existing, installed: false };
  if (existing.source === 'environment') throw new Error('AGY_ACP_BINARY selects an incomplete runtime; fix or unset it before managed installation');
  if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Managed ACP installation currently supports Windows x64 and ARM64');
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`ACP installation is already locked: ${lockPath}. If an installer crashed, verify it stopped before removing this lock.`); throw error; }
  let staging;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const current = findAntigravityRuntime({ cwd, env, directory: root });
    if (current.status === 'ready') return { ...current, installed: false };
    const registry = await fetchImpl(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!registry.ok) throw new Error(`ACP registry request failed: HTTP ${registry.status}`);
    const registryText = await registry.text();
    if (Buffer.byteLength(registryText) > 65536) throw new Error('ACP registry entry exceeds 64 KiB');
    const distribution = selectWindowsDistribution(JSON.parse(registryText), arch, platform);
    staging = mkdtempSync(join(root, '.install-'));
    const archive = join(staging, 'runtime.zip'), unpacked = join(staging, 'unpacked');
    const download = await fetchImpl(distribution.archive, { signal: AbortSignal.timeout(600000), redirect: 'error' });
    if (!download.ok || !download.body) throw new Error(`ACP download failed: HTTP ${download.status}`);
    if (Number(download.headers.get('content-length')) > MAX_ARCHIVE_BYTES) { await download.body.cancel(); throw new Error('ACP download exceeds 8 GiB'); }
    const hash = createHash('sha256'); let size = 0;
    const audit = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) return callback(new Error('ACP download exceeds 8 GiB'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(download.body), audit, createWriteStream(archive, { flags: 'wx' }));
    if (!size) throw new Error('ACP archive is empty');
    await extract(archive, unpacked);
    const unpackedBinary = findPair(unpacked);
    const installName = `${distribution.version}-${distribution.target}-${staging.split(/[\\/]/).at(-1).slice('.install-'.length)}`;
    const installedDirectory = join(root, installName);
    if (!contained(root, installedDirectory)) throw new Error('ACP installation path escapes its runtime directory');
    const binaryRelative = relative(unpacked, unpackedBinary);
    renameSync(unpacked, installedDirectory);
    const binary = join(installedDirectory, binaryRelative);
    const metadata = { version: distribution.version, target: distribution.target, binary: relative(root, binary), archive: distribution.archive, sha256: hash.digest('hex'), archiveBytes: size, installedAt: new Date().toISOString() };
    const marker = join(root, `.current-${process.pid}.json`);
    writeFileSync(marker, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    renameSync(marker, join(root, 'current.json'));
    return { ...inspect(binary, 'managed', distribution.version), installed: true, sha256: metadata.sha256, archive: metadata.archive };
  } finally {
    if (staging && contained(root, staging)) rmSync(staging, { recursive: true, force: true });
    await lock.close(); await unlink(lockPath);
  }
}
