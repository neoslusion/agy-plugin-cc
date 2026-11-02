import { agyExecutor } from './agy.mjs';
import { codexExecutor } from './codex.mjs';
import { claudeExecutor } from './claude.mjs';
import { opencodeExecutor } from './opencode.mjs';
import { runCodexAppServer } from './codex-app-server.mjs';
import { runClaudeAgentSdk } from './claude-agent-sdk.mjs';
import { runAntigravityAcp } from './managed-antigravity-acp.mjs';
import { executorCapabilities, requireCapabilities } from './capabilities.mjs';
import { findAntigravityRuntime } from '../antigravity-runtime.mjs';

const REGISTRY = { agy: agyExecutor, codex: codexExecutor, claude: claudeExecutor, opencode: opencodeExecutor };

export function get(id, integration = 'cli') {
  const executor = Object.hasOwn(REGISTRY, id) ? REGISTRY[id] : null;
  if (!executor) {
    throw new Error(`unknown executor "${id}" (known: ${Object.keys(REGISTRY).join(', ')})`);
  }
  const capabilities = executorCapabilities(id, integration);
  if (integration === 'cli') return Object.assign(executor, { capabilities });
  const run = { 'app-server': runCodexAppServer, 'agent-sdk': runClaudeAgentSdk, acp: runAntigravityAcp }[integration];
  return {
    ...executor,
    capabilities,
    preflight: ({ cwd, env = process.env } = {}) => integration === 'acp'
      ? (() => { const runtime = findAntigravityRuntime({ cwd, env }); return { ready: runtime.status === 'ready', binary: runtime.status === 'ready', auth: null, runtime,
          hint: 'File presence only; use providers --executor agy --integration acp --probe to check the protocol, or acp-setup --install if missing.' }; })()
      : executor.preflight({ cwd, env }),
    runTask: (input, context) => { requireCapabilities(id, { ...input.options, integration }); return run(input, context); },
  };
}

export function list() {
  return Object.values(REGISTRY).map((e) => ({ id: e.id, binary: e.binary, integrations: { codex: ['cli', 'app-server'], claude: ['cli', 'agent-sdk'], agy: ['cli', 'acp'] }[e.id] ?? ['cli'] }));
}
