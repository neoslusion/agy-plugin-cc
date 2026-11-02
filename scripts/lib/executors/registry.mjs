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
const RICH_RUNNERS = { 'app-server': runCodexAppServer, 'agent-sdk': runClaudeAgentSdk, acp: runAntigravityAcp };

function acpPreflight({ cwd, env = process.env } = {}) {
  const runtime = findAntigravityRuntime({ cwd, env });
  return {
    ready: runtime.status === 'ready',
    binary: runtime.status === 'ready',
    auth: null,
    runtime,
    hint: 'File presence only; use providers --executor agy --integration acp --probe to check the protocol, or acp-setup --install if missing.',
  };
}

export function get(id, integration = 'cli') {
  const executor = Object.hasOwn(REGISTRY, id) ? REGISTRY[id] : null;
  if (!executor) {
    throw new Error(`unknown executor "${id}" (known: ${Object.keys(REGISTRY).join(', ')})`);
  }
  // Return a per-call view instead of mutating the registered singleton: the same
  // process can route different integrations, and a shared object leaks state.
  const capabilities = executorCapabilities(id, integration);
  if (!executor.integrations.includes(integration)) {
    throw new Error(`${id} does not support integration ${integration} (supported: ${executor.integrations.join(', ')})`);
  }
  if (integration === 'cli') return { ...executor, capabilities };
  const run = RICH_RUNNERS[integration];
  return {
    ...executor,
    capabilities,
    preflight: integration === 'acp' ? acpPreflight : executor.preflight,
    runTask: (input, context) => {
      requireCapabilities(id, { ...input.options, integration });
      return run(input, context);
    },
  };
}

export function list() {
  return Object.values(REGISTRY).map(executor => ({ id: executor.id, binary: executor.binary, integrations: [...executor.integrations] }));
}
