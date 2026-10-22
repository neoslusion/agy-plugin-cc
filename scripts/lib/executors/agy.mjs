import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { binaryAvailable, runCommand } from '../process.mjs';
import { collectReviewContext, resolveReviewTarget } from '../git.mjs';
import { AgyBrokerClient } from '../rpc-client.mjs';
import { ensureBrokerSession, isBrokerAlive, loadBrokerSession } from '../broker-lifecycle.mjs';
import { resolveClaudeSessionPath, extractClaudeContext } from '../claude-session-transfer.mjs';
import { terminateProcess } from './cli-process.mjs';

export const id = 'agy';
export const binary = 'agy';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
const NOTICE_MARKERS = [
  'auto-denied',
  'permission that headless mode cannot prompt',
  // agy >= 1.1.x wording
  'soft-denying tool confirmation',
];

// Matches both the hard envelope error ("permission check failed for command ...")
// and soft-deny notices emitted by headless runs.
export const PERMISSION_DENIED_RE =
  /permission check failed|user denied permission|soft-denying tool confirmation|auto-denied/i;

export function isPermissionDenied(result = {}) {
  const hay = [result.error, result.notice, result.response].filter(Boolean).join('\n');
  return PERMISSION_DENIED_RE.test(hay);
}

// Returns a human hint for permission denials, or null when nothing actionable applies.
// Task/plan jobs without approval can be re-run with --approve-all; reviews are
// read-only by design; an approved run that still gets denied points at scope/policy.
export function permissionDeniedHint(result = {}, { jobClass, approveAll } = {}) {
  if (!isPermissionDenied(result)) return null;
  if (jobClass === 'review') {
    return 'review runs are read-only by design; denials mean the prompt asked for out-of-scope tools.';
  }
  if (!approveAll) {
    return 'headless mode denies tools that need approval (every shell command, even read-only ones). '
      + 'Re-run with --approve-all to allow them (maps to agy --dangerously-skip-permissions).';
  }
  return 'this run had --approve-all yet tools were still denied; the tool likely touched resources '
      + 'outside the trusted workspace (use --add-dir) or hit an admin permission policy.';
}

export function msToDuration(ms) {
  const totalS = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  let out = '';
  if (h) out += `${h}h`;
  if (m || h) out += `${m}m`;
  if (s || !m) out += `${s}s`;
  return out || '0s';
}

export function buildArgs({ job = {}, prompt, options = {} }) {
  const { outputFormat = 'stream-json', model, effort, agent, conversation, approveAll, jsonSchema, timeoutMs } = options;
  const args = ['-p', prompt, '--output-format', outputFormat, '--print-timeout', msToDuration(timeoutMs ?? DEFAULT_TIMEOUT_MS), '--disable-slash-commands'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (agent) args.push('--agent', agent);
  if (conversation) args.push('--conversation', conversation);
  if (jsonSchema) args.push('--json-schema', jsonSchema);
  if (job.jobClass !== 'review' && !options.readOnly && approveAll) args.push('--dangerously-skip-permissions');
  if (job.jobClass === 'review' || options.readOnly) args.push('--mode', 'plan');
  return args;
}

export function preflight({ cwd, probeCommand = (args) => runCommand(binary, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS }) } = {}) {
  if (!binaryAvailable(binary)) {
    return {
      ready: false,
      binary: false,
      auth: null,
      version: null,
      hint: `The ${binary} CLI is not installed. Install it (see https://antigravity.google/download), then run "${binary}" once interactively to sign in.`,
    };
  }
  const version = runCommand(binary, ['--version'], { cwd }).stdout.trim() || null;
  const probe = probeCommand(['models']);
  const auth = probe.code === 0;
  return {
    ready: auth,
    binary: true,
    auth,
    version,
    hint: auth ? null : `${binary} is installed but not authenticated. Run "${binary}" interactively once to sign in (Google account / AI credits).`,
  };
}

export function collectContext({ cwd, jobClass, base, scope, taskScope, transcriptPath } = {}) {
  if (jobClass === 'review' && cwd) {
    try {
      const target = resolveReviewTarget(cwd, { base, scope });
      const ctx = collectReviewContext(cwd, target);
      return {
        promptExtra: ctx.mode === 'inline' ? ctx.diff : ctx.guidance,
        changedFilesHint: ctx.changedFiles,
      };
    } catch {
      return { promptExtra: null, changedFilesHint: [] };
    }
  }

  // For task/plan execution, collect broader context including Claude session
  if ((jobClass === 'task' || jobClass === 'plan') && cwd) {
    try {
      const gitStatus = runCommand('git', ['status', '--porcelain'], { cwd });
      const changedFiles = gitStatus.code === 0
        ? gitStatus.stdout.split('\n').filter(l => l.trim()).map(l => l.slice(3))
        : [];

      // Extract Claude session context if available
      let claudeContext = null;
      if (transcriptPath) {
        const sessionPath = resolveClaudeSessionPath(cwd, { source: transcriptPath });
        if (sessionPath) {
          claudeContext = extractClaudeContext(sessionPath, { maxTurns: 10 });
        }
      }

      return {
        promptExtra: null,
        changedFilesHint: changedFiles,
        gitBranch: runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).stdout.trim(),
        claudeContext
      };
    } catch {
      return { promptExtra: null, changedFilesHint: [] };
    }
  }

  return { promptExtra: null, changedFilesHint: [] };
}

function porcelainPaths(cwd) {
  const res = runCommand('git', ['status', '--porcelain'], { cwd });
  if (res.code !== 0) return null;
  return new Set(
    res.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3).split(' -> ').pop())
  );
}

function changedFilesSince(cwd, baseline) {
  if (baseline === null) return [];
  const now = porcelainPaths(cwd);
  if (now === null) return [];
  return [...now].filter((p) => !baseline.has(p));
}

export function extractNotice(stderr) {
  const lines = stderr.split('\n').filter((l) => NOTICE_MARKERS.some((m) => l.includes(m)));
  if (lines.length === 0) return null;
  return lines.map((l) => l.trim()).join('\n').slice(0, 2000);
}

const AGY_STATUS_TO_JOB_STATUS = {
  SUCCESS: 'completed',
  ERROR: 'failed',
  CANCELED: 'cancelled',
  INTERRUPTED: 'cancelled',
  INVALID: 'failed',
  WAITING: 'failed',
  RUNNING: 'failed',
};

export async function runTaskViaBroker({ job = {}, prompt, options = {}, onProgress = () => {} }, { cwd } = {}) {
  const session = await ensureBrokerSession(cwd);
  const client = await AgyBrokerClient.connect(cwd, { session });

  try {
    const args = buildArgs({ job, prompt, options });
    let result = { status: 'pending', response: '', error: null, exitCode: null, notice: null };

    // Set up notification handler for streaming updates
    client.setNotificationHandler((message) => {
      if (message.method === 'agy/notification' && message.params) {
        const evt = message.params;

        if (evt.event === 'step_update' && evt.step_update) {
          const step = evt.step_update;

          // Emit progress based on step type
          if (step.step_type === 'tool' && step.state === 'ACTIVE') {
            onProgress({ type: 'tool', name: step.tool_name, state: step.state });
          } else if (step.step_type === 'agent_response') {
            onProgress({ type: 'phase', phase: 'responding' });
          }
        }
      }
    });

    // Execute via broker
    const brokerResult = await client.request('agy/run', { args });

    result.exitCode = brokerResult.exitCode ?? null;
    result.response = brokerResult.stdout ?? '';
    result.error = brokerResult.stderr ?? null;
    result.status = brokerResult.status === 'completed' ? 'completed' : 'failed';

    // Extract notice from stderr
    result.notice = extractNotice(brokerResult.stderr ?? '');

    return result;
  } finally {
    await client.close();
  }
}

export function runTask({ job = {}, prompt, options = {}, onProgress = () => {}, onStdoutLine, onStderrLine }, { spawnFn = spawn, cwd, useBroker = false, env = process.env } = {}) {
  // If broker mode is enabled, use broker execution
  if (useBroker) {
    return runTaskViaBroker({ job, prompt, options, onProgress }, { cwd });
  }

  // Otherwise, use direct spawn (existing implementation)
  return new Promise((resolve, reject) => {
    const args = buildArgs({ job, prompt, options });
    const stream = (options.outputFormat ?? 'stream-json') === 'stream-json';
    const baseline = cwd ? porcelainPaths(cwd) : null;
    let child;
    try {
      const binaryName = options.binary ?? env.AGY_BINARY ?? binary;
      const isNodeScript = /\.(mjs|js|cjs)$/i.test(binaryName);
      const spawnCmd = isNodeScript ? process.execPath : binaryName;
      const spawnArgs = isNodeScript ? [binaryName, ...args] : args;
      child = spawnFn(spawnCmd, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32', cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' } });
      child.on('spawn', () => onProgress({ type: 'spawn', pid: child.pid, binary: binaryName }));
    } catch (err) {
      reject(err);
      return;
    }
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdoutBuf = '';
    let stderrBuf = '';
    let pending = '';
    let envelope = null;
    let phasesSeen = [];
    // Track subagent invocations for visibility (mirrors codex pendingCollaborations).
    // agy waits for all subagents before emitting 'result', so completion is already
    // correct — this adds richer progress and a count in the final result.
    const subagentsSeen = new Map(); // id/name → { name, state }
    let subagentsInvoked = 0;

    const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents']);

    const emitPhase = (phase) => {
      if (phasesSeen[phasesSeen.length - 1] === phase) return;
      phasesSeen.push(phase);
      onProgress({ type: 'phase', phase });
    };

    const handleSubagentTool = (s) => {
      const params = s.tool_info?.parameters ?? {};
      const subagentName = params.subagent_name ?? params.name ?? params.agent ?? s.tool_name;
      const key = params.subagent_id ?? params.id ?? subagentName;
      if (s.state === 'ACTIVE' || s.state === 'PENDING') {
        if (!subagentsSeen.has(key)) {
          subagentsInvoked++;
          subagentsSeen.set(key, { name: subagentName, state: s.state });
          onProgress({ type: 'subagent-start', name: subagentName, tool: s.tool_name, count: subagentsSeen.size });
        }
      } else if (s.state === 'DONE' || s.state === 'ERROR') {
        const entry = subagentsSeen.get(key);
        if (entry) {
          entry.state = s.state;
          onProgress({ type: 'subagent-done', name: subagentName, tool: s.tool_name, state: s.state });
        }
      }
    };

    const handleStep = (s) => {
      if (!s) return;
      switch (s.step_type) {
        case 'user_input':
          emitPhase('starting');
          break;
        case 'tool':
          emitPhase('acting');
          if (SUBAGENT_TOOLS.has(s.tool_name)) {
            handleSubagentTool(s);
          }
          onProgress({ type: 'tool', name: s.tool_name, parameters: s.tool_info?.parameters, state: s.state });
          if (s.state === 'ERROR' && s.tool_info?.error) {
            onProgress({ type: 'tool-error', name: s.tool_name, message: s.tool_info.error.message });
          }
          break;
        case 'agent_response':
          emitPhase('responding');
          break;
        case 'checkpoint':
          emitPhase('verifying');
          break;
        default:
          break;
      }
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.event === 'init') {
        emitPhase('starting');
      } else if (evt.event === 'step_update') {
        handleStep(evt.step_update);
      } else if (evt.event === 'result') {
        envelope = evt.result;
        onProgress({ type: 'result', result: evt.result });
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = outDecoder.write(chunk);
      stdoutBuf += text;
      onStdoutLine?.(text);
      if (!stream) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk) => {
      const text = errDecoder.write(chunk);
      stderrBuf += text;
      onStderrLine?.(text);
    });

    let timedOut = false;
    const kill = () => { try { terminateProcess(child.pid); } catch {} };
    process.once('SIGTERM', kill);
    process.once('SIGINT', kill);
    const watchdog = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(watchdog);
      process.removeListener('SIGTERM', kill);
      process.removeListener('SIGINT', kill);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (exitCode) => {
      cleanup();
      if (pending.trim()) handleLine(pending);
      let jsonEnvelope = null;
      if (!stream) {
        try {
          jsonEnvelope = JSON.parse(stdoutBuf);
        } catch {}
      }
      const env = stream ? envelope : jsonEnvelope;
      const agyStatus = env?.status ?? 'ERROR';
      const jobStatus = timedOut || exitCode !== 0 || !env ? 'failed' : AGY_STATUS_TO_JOB_STATUS[agyStatus] ?? 'failed';
      resolve({
        status: jobStatus,
        agyStatus,
        response: env?.response ?? '',
        error: timedOut ? `Executor timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : env?.error ?? (jobStatus === 'failed' ? (stderrBuf.trim() || 'agy exited without a successful result') : null),
        conversationId: env?.conversation_id ?? null,
        usage: env?.usage ?? null,
        exitCode,
        notice: extractNotice(stderrBuf),
        changedFiles: changedFilesSince(cwd, baseline),
        phasesSeen,
        structuredOutput: env?.structured_output ?? null,
        subagentsInvoked,
      });
    });
  });
}

export function cancelJob(pid) {
  return terminateProcess(pid);
}

export async function cancel() {
  throw new Error('agy.cancel requires a pid; use cancelJob(pid) with the tracked job pid');
}

export const agyExecutor = {
  id,
  binary,
  preflight,
  collectContext,
  runTask,
  cancel: cancelJob,
  isPermissionDenied,
  permissionDeniedHint,
};
