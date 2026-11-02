import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROLE_CONTRACTS, roleContract, nativeAgentName } from './roles.mjs';
import { executorCapabilities } from './executors/capabilities.mjs';

const EXECUTORS = new Set(['agy', 'codex', 'claude', 'opencode']);
const OPTION_KEYS = new Set(['model', 'effort', 'agent', 'advisor', 'timeoutMs', 'integration']);
const SUPERVISOR_DEFAULTS = {
  maxIterations: 4,
  maxWorkers: 2,
  plannerRole: 'planner',
  executorRole: 'executor',
  reviewerRole: 'reviewer',
  monitorRole: null,
  verifyCommands: [],
};

function verifyCommands(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of command arrays`);
  for (const command of value) {
    if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part.trim())) {
      throw new Error(`${label} entries must be nonempty arrays of strings`);
    }
  }
}


function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function options(value, label, role = false) {
  object(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (role && key === 'executor') {
      if (!EXECUTORS.has(entry)) throw new Error(`${label}: unknown executor ${entry}`);
    } else if (role && key === 'transport') {
      if (!['auto', 'native', 'cli'].includes(entry)) throw new Error(`${label}: transport must be auto, native or cli`);
    } else if (role && key === 'purpose') {
      if (!Object.hasOwn(ROLE_CONTRACTS, entry)) throw new Error(`${label}: unknown purpose ${entry}`);
    } else if (role && key === 'instructions') {
      if (typeof entry !== 'string') throw new Error(`${label}.instructions must be a string`);
    } else if (role && key === 'advisorRole') {
      if (typeof entry !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry)) throw new Error(`${label}.advisorRole must be a role name`);
    } else if (role && key === 'advisorRounds') {
      if (!Number.isSafeInteger(entry) || entry < 0 || entry > 5) throw new Error(`${label}.advisorRounds must be an integer from 0 to 5`);
    } else if (!OPTION_KEYS.has(key)) {
      throw new Error(`${label}: unsupported option ${key}`);
    } else if (key === 'timeoutMs') {
      if (!Number.isSafeInteger(entry) || entry <= 0 || entry > 2_147_000_000) throw new Error(`${label}.timeoutMs must be a positive integer below 2147000001`);
    } else if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label}.${key} must be a nonempty string`);
    }
  }
}

// The advisor is a Claude Code server tool, passed to `claude -p` as --advisor.
function requireAdvisorRoute(label, advisor, executor, integration = 'cli') {
  if (advisor !== undefined && (executor !== 'claude' || integration !== 'cli')) throw new Error(`${label}: advisor requires the claude executor with cli integration`);
}

export function loadDelegationConfig(cwd, file) {
  const configPath = resolve(cwd, file ?? '.agent-delegation.json');
  if (!existsSync(configPath) && !file) return { configPath, defaultExecutor: 'opencode', executors: {}, roles: {}, automation: { mode: 'auto', maxParallel: 4 }, supervisor: { ...SUPERVISOR_DEFAULTS } };
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  object(config, 'delegation config');
  for (const key of Object.keys(config)) {
    if (!['defaultExecutor', 'executors', 'roles', 'orchestrator', 'automation', 'supervisor'].includes(key)) throw new Error(`Unknown delegation config field: ${key}`);
  }
  if (!EXECUTORS.has(config.defaultExecutor ?? 'opencode')) throw new Error(`Unknown default executor: ${config.defaultExecutor}`);
  if (config.executors !== undefined) object(config.executors, 'executors');
  if (config.roles !== undefined) object(config.roles, 'roles');
  for (const [id, value] of Object.entries(config.executors ?? {})) {
    if (!EXECUTORS.has(id)) throw new Error(`Unknown executor: ${id}`);
    options(value, `executors.${id}`);
    executorCapabilities(id, value.integration);
    requireAdvisorRoute(`executors.${id}`, value.advisor, id, value.integration);
  }
  for (const [role, value] of Object.entries(config.roles ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(role)) throw new Error(`Invalid role name: ${role}`);
    options(value, `roles.${role}`, true);
    executorCapabilities(value.executor ?? config.defaultExecutor ?? 'opencode', value.integration ?? config.executors?.[value.executor ?? config.defaultExecutor ?? 'opencode']?.integration);
    if (value.transport === 'native' && !['codex', 'claude'].includes(value.executor ?? config.defaultExecutor ?? 'opencode')) throw new Error(`roles.${role}: native transport requires codex or claude`);
    requireAdvisorRoute(`roles.${role}`, value.advisor, value.executor ?? config.defaultExecutor ?? 'opencode', value.integration ?? config.executors?.[value.executor ?? config.defaultExecutor ?? 'opencode']?.integration);
    if (value.transport !== 'cli' && value.transport && value.agent) throw new Error(`roles.${role}: agent is only supported with cli transport`);
  }
  for (const [role, value] of Object.entries(config.roles ?? {})) {
    if (value.advisorRounds !== undefined && value.advisorRole === undefined) throw new Error(`roles.${role}.advisorRounds requires advisorRole`);
    if (value.advisorRole === undefined) continue;
    const advisor = config.roles[value.advisorRole];
    if (!advisor) throw new Error(`roles.${role}.advisorRole names unknown role ${value.advisorRole}`);
    if (value.advisorRole === role || advisor.advisorRole !== undefined) throw new Error(`roles.${role}.advisorRole must name a role without its own advisor`);
    if (advisor.transport === 'native') throw new Error(`roles.${role}.advisorRole must use cli transport`);
  }
  if (config.orchestrator !== undefined) {
    object(config.orchestrator, 'orchestrator');
    for (const [key, value] of Object.entries(config.orchestrator)) {
      if (!['host', 'model', 'effort', 'instructions'].includes(key) || typeof value !== 'string') throw new Error(`Invalid orchestrator setting: ${key}`);
    }
    if (config.orchestrator.host && !['codex', 'claude'].includes(config.orchestrator.host)) throw new Error('orchestrator.host must be codex or claude');
  }
  if (config.automation !== undefined) {
    object(config.automation, 'automation');
    for (const key of Object.keys(config.automation)) if (!['mode', 'maxParallel'].includes(key)) throw new Error(`Unknown automation setting: ${key}`);
    if (config.automation.mode !== undefined && !['auto', 'manual'].includes(config.automation.mode)) throw new Error('automation.mode must be auto or manual');
    if (config.automation.maxParallel !== undefined && (!Number.isSafeInteger(config.automation.maxParallel) || config.automation.maxParallel < 1 || config.automation.maxParallel > 16)) throw new Error('automation.maxParallel must be an integer from 1 to 16');
  }
  if (config.supervisor !== undefined) {
    object(config.supervisor, 'supervisor');
    for (const key of Object.keys(config.supervisor)) {
      if (!Object.hasOwn(SUPERVISOR_DEFAULTS, key)) throw new Error(`Unknown supervisor setting: ${key}`);
    }
    for (const key of ['maxIterations', 'maxWorkers']) {
      const value = config.supervisor[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 16)) throw new Error(`supervisor.${key} must be an integer from 1 to 16`);
    }
    for (const key of ['plannerRole', 'executorRole', 'reviewerRole']) {
      const value = config.supervisor[key];
      if (value !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`supervisor.${key} must be a valid role name`);
    }
    if (config.supervisor.monitorRole !== undefined && config.supervisor.monitorRole !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(config.supervisor.monitorRole)) throw new Error('supervisor.monitorRole must be a role name or null');
    if (config.supervisor.verifyCommands !== undefined) verifyCommands(config.supervisor.verifyCommands, 'supervisor.verifyCommands');
  }
  return { defaultExecutor: 'opencode', executors: {}, roles: {}, ...config, automation: { mode: 'auto', maxParallel: 4, ...config.automation }, supervisor: { ...SUPERVISOR_DEFAULTS, ...config.supervisor }, configPath };
}

export function resolveRoute(config, opts) {
  const role = opts.role && Object.hasOwn(config.roles, opts.role) ? config.roles[opts.role] : null;
  if (opts.role && !role) throw new Error(`Unknown role: ${opts.role}`);
  const executor = opts.executor ?? role?.executor ?? config.defaultExecutor;
  if (!EXECUTORS.has(executor)) throw new Error(`Unknown executor: ${executor}`);
  // A role's model belongs to its executor; changing executor must not carry it across providers.
  const roleOptions = opts.executor && opts.executor !== (role?.executor ?? config.defaultExecutor) ? {} : role;
  const defaults = { ...config.executors[executor], ...roleOptions };
  const contract = opts.role ? roleContract(opts.role, role) : {};
  const preferred = role?.transport ?? 'cli';
  const transport = opts.executor ? 'cli' : preferred === 'auto' ? (opts.host === executor && ['codex', 'claude'].includes(executor) ? 'native' : 'cli') : preferred;
  return {
    ...defaults,
    ...(defaults.timeoutMs ? { 'timeout-ms': String(defaults.timeoutMs) } : {}),
    ...opts,
    executor,
    transport,
    integration: opts.integration ?? defaults.integration ?? 'cli',
    capabilities: executorCapabilities(executor, opts.integration ?? defaults.integration ?? 'cli'),
    ...contract,
    ...(transport === 'native' ? { nativeAgent: nativeAgentName(opts.role) } : {}),
  };
}
