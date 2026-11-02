import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (root, relative) => readFileSync(join(root, relative), 'utf8');
const versionOf = (root, relative) => JSON.parse(read(root, relative)).version;

// The package, both host manifests, the lockfile and the changelog each carry a version. They drift
// silently because no runtime reads all of them, so the check is explicit instead of best-effort.
export function versionMismatches(root = ROOT) {
  const lock = JSON.parse(read(root, 'package-lock.json'));
  const versions = {
    'package.json': versionOf(root, 'package.json'),
    'package-lock.json': lock.version ?? lock.packages?.['']?.version,
    'plugins/agent-delegation/.claude-plugin/plugin.json': versionOf(root, 'plugins/agent-delegation/.claude-plugin/plugin.json'),
    'plugins/agent-delegation/.codex-plugin/plugin.json': versionOf(root, 'plugins/agent-delegation/.codex-plugin/plugin.json'),
  };
  const changelog = read(root, 'CHANGELOG.md');
  versions['CHANGELOG.md'] = /^##\s+(\d+\.\d+\.\d+)\b/m.exec(changelog)?.[1] ?? null;
  const expected = versions['package.json'];
  return Object.entries(versions)
    .filter(([, version]) => version !== expected)
    .map(([file, version]) => `${file}: ${version ?? '(missing)'} (expected ${expected})`);
}

if (import.meta.main) {
  const mismatches = versionMismatches();
  if (mismatches.length) {
    console.error(`version mismatch:\n${mismatches.map(line => `  ${line}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('versions agree');
  }
}
