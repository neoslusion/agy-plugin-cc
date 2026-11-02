import { collectContext } from './agy.mjs';
import { cliPreflight, runCli, terminateProcess } from './cli-process.mjs';

// OpenCode's read-only built-in agent; writers use its default agent with --auto.
const READ_ONLY_AGENT = 'plan';

export function buildOpencodeArgs({ job = {}, options = {} }) {
  if (options.jsonSchema) throw new Error('opencode executor does not support schema-constrained output; select codex or claude for structured tasks');
  const args = ['run', '--format', 'json'];
  // The background service never sees per-run configuration, so an injected advisor needs a private server.
  if (options.advisorServer) args.push('--standalone');
  const approve = job.jobClass !== 'review' && !options.readOnly && options.approveAll;
  if (approve) args.push('--auto');
  if (options.agent || !approve) args.push('--agent', options.agent ?? READ_ONLY_AGENT);
  // OpenCode selects reasoning effort as a model variant (provider/model#variant).
  if (options.model) args.push('--model', options.effort ? `${options.model}#${options.effort}` : options.model);
  if (options.conversation) args.push('--session', options.conversation);
  return args;
}

// Adds the advisor MCP server to any inline configuration the user already supplies.
function advisorConfig(env, server) {
  if (!server) return {};
  const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
  config.mcp = { ...config.mcp, [server.name]: { type: 'local', command: [server.command, ...server.args], enabled: true } };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

function addUsage(total, tokens = {}, cost = 0) {
  const sum = total ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  sum.input += tokens.input ?? 0; sum.output += tokens.output ?? 0; sum.reasoning += tokens.reasoning ?? 0;
  sum.cacheRead += tokens.cache?.read ?? 0; sum.cacheWrite += tokens.cache?.write ?? 0; sum.cost += cost ?? 0;
  return sum;
}

export async function runTask({ job = {}, prompt, options = {}, onProgress = () => {}, ...handlers }, { cwd, env = process.env } = {}) {
  const result = { status: 'failed', response: '', error: null, conversationId: null, usage: null, structuredOutput: null, changedFiles: [] };
  let text = [], failure = null, started = false;
  // The prompt goes over stdin: assignments can exceed the Windows command-line limit.
  const output = await runCli({
    binary: options.binary ?? env.OPENCODE_BINARY ?? 'opencode', args: buildOpencodeArgs({ job, options }),
    // OpenCode takes its project directory from PWD, which a spawned process inherits unchanged.
    prompt, cwd, env: { ...env, ...advisorConfig(env, options.advisorServer), PWD: cwd ?? process.cwd(), AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, ...handlers,
    onEvent(event) {
      if (event.sessionID) result.conversationId = event.sessionID;
      if (event.type === 'step_start') started = true;
      const part = event.part ?? {};
      if (event.type === 'text' && part.text) text.push(part.text);
      if (event.type === 'tool_use') {
        onProgress({ type: 'tool', name: part.tool ?? 'tool' });
        if (part.state?.status === 'completed') {
          // Edit tools list their files in metadata; fall back to the input path for tools that do not.
          const reported = part.state.metadata?.metadata?.files?.map(entry => entry.file).filter(Boolean) ?? [];
          const input = part.state.input?.path ?? part.state.input?.filePath;
          const files = reported.length ? reported : ['edit', 'write', 'patch'].includes(part.tool) && input ? [input] : [];
          for (const file of files) if (!result.changedFiles.includes(file)) result.changedFiles.push(file);
        }
      }
      // Only intermediate (tool-call) steps report step_finish, so usage can undercount the final answer.
      if (event.type === 'step_finish') result.usage = addUsage(result.usage, part.tokens, part.cost);
      if (event.type === 'error') failure = event.error?.message ?? event.error?.type ?? 'OpenCode reported an error';
    },
  });
  result.response = text.join('\n');
  // OpenCode emits no terminal event; a clean exit after at least one step without an error event is success.
  if (output.error || failure || output.exitCode !== 0 || !started) {
    result.error = output.error ?? failure ?? (output.stderr.trim() || 'OpenCode exited without running a step');
  } else result.status = 'completed';
  return { ...result, exitCode: output.exitCode, notice: output.stderr.trim() || null };
}

export const opencodeExecutor = { id: 'opencode', binary: 'opencode', integrations: ['cli'], preflight: opts => cliPreflight('opencode', opts), runTask, collectContext, cancel: terminateProcess };
