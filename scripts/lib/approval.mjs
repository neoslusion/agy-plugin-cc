import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code permission modes that justify delegating full tool autonomy to
// agy. acceptEdits is deliberately excluded: it only auto-accepts file edits,
// not arbitrary shell execution, so mapping it onto agy's
// --dangerously-skip-permissions would over-grant.
const INHERIT_MODES = new Set(['bypassPermissions']);

const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);

function readDefaultMode(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.permissions?.defaultMode ?? null;
  } catch {
    return null;
  }
}

// True when any Claude settings layer (project-local > project > user) sets
// permissions.defaultMode to a mode we inherit. Honors CLAUDE_CONFIG_DIR the
// same way Claude Code does when locating the user-level settings file.
export function claudeBypassConfigured({ cwd = process.cwd(), env = process.env } = {}) {
  const userBase = env.CLAUDE_CONFIG_DIR ?? homedir();
  const candidates = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(userBase, 'settings.json'),
  ];
  return candidates.some((p) => INHERIT_MODES.has(readDefaultMode(p)));
}

// The SessionStart hook exports AGY_APPROVE_ALL=1 when the *live* session is in
// bypassPermissions mode; truthy-string check keeps it forgiving.
export function envSaysApproveAll(env = {}) {
  return TRUTHY_ENV.has(String(env.AGY_APPROVE_ALL ?? '').toLowerCase());
}

// Resolution order:
//   1. explicit flag (--approve-all / --no-approve-all) always wins
//   2. live session mode (AGY_APPROVE_ALL from CLAUDE_ENV_FILE)
//   3. plugin config (`setup --enable-approve-all`, per workspace)
//   4. configured defaultMode in Claude settings files
//   5. off (permission failures then surface the actionable hint)
export function resolveApproveAll({ explicit, config = false, cwd = process.cwd(), env = process.env } = {}) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (envSaysApproveAll(env)) return true;
  if (config === true) return true;
  if (claudeBypassConfigured({ cwd, env })) return true;
  return false;
}
