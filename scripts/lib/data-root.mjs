import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const APP_NAME = 'agent-delegation';
// The first releases kept state under the system temporary directory with this name.
export const LEGACY_DIR_NAME = 'agy-companion';

// Task state, logs and context snapshots outlive a terminal, so the default belongs
// in a per-user data directory rather than the system temporary directory.
export function defaultDataRoot({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || env.APPDATA || join(home, 'AppData', 'Local'), APP_NAME);
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME);
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), APP_NAME);
}

const overridden = env => env.AGENT_DELEGATION_DATA || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || null;

// Move state written by older releases out of the temporary directory. Only the
// default location is migrated; an explicit data directory is never touched.
export function migrateLegacyData(root, { env = process.env, tmp = tmpdir() } = {}) {
  if (overridden(env)) return null;
  const legacy = join(tmp, LEGACY_DIR_NAME);
  if (!existsSync(legacy) || existsSync(root)) return null;
  const staging = `${root}.migrating`;
  try {
    mkdirSync(dirname(root), { recursive: true });
    try {
      renameSync(legacy, root);
    } catch {
      // A different filesystem cannot be renamed in one step. Copy into a staging
      // directory first so a partial copy never looks like a complete data root.
      rmSync(staging, { recursive: true, force: true });
      cpSync(legacy, staging, { recursive: true });
      renameSync(staging, root);
      rmSync(legacy, { recursive: true, force: true });
    }
    return { from: legacy, to: root };
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return null;
  }
}

// Precedence is unchanged for explicit host directories; only the fallback moved.
export function resolveDataRoot(env = process.env) {
  const explicit = overridden(env);
  if (explicit) return explicit;
  const root = defaultDataRoot({ env });
  migrateLegacyData(root, { env });
  return root;
}
