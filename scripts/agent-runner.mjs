#!/usr/bin/env node
import { runMain as runCompanion } from './agy-companion.mjs';
import { resolve } from 'node:path';
import { readFileSafe } from './lib/fs.mjs';
import { runSupervisor } from './lib/supervisor.mjs';
import { parseArgs } from './lib/args.mjs';
import { loadDelegationConfig, resolveRoute } from './lib/delegation-config.mjs';
import { configureProject, launchHost, launchSpec } from './lib/orchestration.mjs';
import { TASK_COMMANDS, runTaskApi, taskRoot, taskSession } from './lib/task-api.mjs';
import { visibleTasks, selectTask } from './lib/task-view.mjs';
import { runTerminalTasks } from './lib/terminal-tasks.mjs';
import { runDispatch } from './lib/task-dispatch.mjs';
import { runAcpSetup } from './lib/acp-setup.mjs';
import { runTaskDoctor } from './lib/task-doctor.mjs';
import { runProviderReadiness } from './lib/provider-readiness.mjs';

export async function runMain(argv, context = {}) {
  const [command, ...rest] = argv;
  if (command === 'doctor') return runTaskDoctor(rest, context);
  if (command === 'providers') return runProviderReadiness(rest, context);
  if (command === 'acp-setup') return runAcpSetup(rest, context);
  if (['delegate', 'follow-up'].includes(command)) return runDispatch(command, rest, context);
  if (['tasks', 'wait', 'watch'].includes(command)) return runTerminalTasks(command, rest, context);
  if (TASK_COMMANDS.includes(command)) return runTaskApi(command, rest, context);
  if (command === 'cancel') {
    try {
      const env = context.env ?? process.env;
      if (env.AGENT_DELEGATION_WORKER === '1') throw new Error('A delegated worker cannot cancel parent tasks');
      const { opts, positionals } = parseArgs(rest);
      for (const key of Object.keys(opts)) if (!['cwd', 'session-id'].includes(key)) throw new Error(`--${key} is not supported by cancel`);
      if (positionals.length !== 1) throw new Error('cancel requires one task ID');
      const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
      const snapshot = selectTask(taskRoot(cwd, env), visibleTasks(taskRoot(cwd, env), opts['session-id'] ?? taskSession(env)), positionals[0]);
      return await runCompanion(['cancel', snapshot.taskId], { ...context, cwd, env, legacy: false });
    } catch (error) { (context.err ?? process.stderr).write(`error: ${error.message}\n`); return 1; }
  }
  if (command === 'run') {
    const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
    try {
      if (env.AGENT_DELEGATION_WORKER === '1') throw new Error('a delegated worker cannot start a supervisor run');
      const { opts, positionals } = parseArgs(rest);
      const allowed = ['cwd', 'config', 'session-id', 'task-file', 'resume', 'supervisor-id', 'max-iterations', 'max-workers', 'integrate', 'allow-dirty', 'approve-all', 'json', 'host'];
      if (opts.unknown?.length || positionals.length > 1) throw new Error('Unexpected arguments; use run --task-file FILE | TASK [--max-iterations N] [--max-workers N] [--json]');
      for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported by run`);
      if (opts['task-file'] && positionals.length) throw new Error('Use --task-file or an inline task, not both');
      const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
      const task = opts['task-file'] ? readFileSafe(resolve(cwd, opts['task-file']), { maxBytes: 2 * 1024 * 1024 }) : positionals.join(' ');
      if (!task?.trim() && !opts.resume) throw new Error('run requires a task or --task-file');
      const record = await runSupervisor({
        cwd,
        env: opts['session-id'] ? { ...env, AGENT_SESSION_ID: opts['session-id'] } : env,
        task,
        configFile: opts.config,
        resumeId: opts.resume ? (opts['supervisor-id'] ?? '') : null,
        options: {
          host: opts.host,
          maxIterations: opts['max-iterations'],
          maxWorkers: opts['max-workers'],
          integrate: opts.integrate,
          allowDirty: opts['allow-dirty'],
          approveAll: opts['approve-all'],
        },
      });
      if (opts.json) out.write(JSON.stringify(record) + '\n');
      else {
        out.write(`Supervisor ${record.status}: ${record.summary ?? record.errorMessage ?? record.phase}\n`);
        if (record.integrated) out.write('Changes were integrated into the parent worktree.\n');
      }
      return record.status === 'completed' ? 0 : 1;
    } catch (error) {
      err.write(`error: ${error.message}\n`);
      return 1;
    }
  }
  if (['configure', 'route', 'start'].includes(command)) {
    const out = context.out ?? process.stdout, err = context.err ?? process.stderr;
    try {
      if ((context.env ?? process.env).AGENT_DELEGATION_WORKER === '1' && command !== 'route') throw new Error('A delegated worker cannot configure or launch an orchestrator');
      const { opts, positionals } = parseArgs(rest, { extraBool: ['dry-run'], extraValue: ['host'] });
      if (opts.unknown?.length || positionals.length) throw new Error('Unexpected arguments; use configure --host codex|claude, route --role NAME --host HOST, or start [--host HOST]');
      const allowed = command === 'route' ? ['cwd', 'config', 'host', 'role', 'executor', 'model', 'effort', 'agent', 'integration', 'timeout-ms', 'json'] : ['cwd', 'config', 'host', 'dry-run'];
      for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported by ${command}`);
      const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
      if (command === 'configure') {
        out.write(JSON.stringify(configureProject({ cwd, host: opts.host, configFile: opts.config, dryRun: opts['dry-run'] }), null, 2) + '\n');
        return 0;
      }
      const config = loadDelegationConfig(cwd, opts.config);
      if (command === 'route') {
        if (!opts.role) throw new Error('route requires --role NAME');
        if (opts.host && !['codex', 'claude'].includes(opts.host)) throw new Error('--host must be codex or claude');
        const route = resolveRoute(config, opts);
        if (route.transport === 'native' && opts.host !== route.executor) throw new Error(`Native role requires host ${route.executor}; select that host or explicitly override --executor`);
        out.write(JSON.stringify(route, null, 2) + '\n');
        return 0;
      }
      const spec = launchSpec(config, opts.host);
      const report = configureProject({ cwd, host: spec.binary, configFile: opts.config, dryRun: opts['dry-run'] });
      if (opts['dry-run']) { out.write(JSON.stringify({ ...spec, configuration: report }, null, 2) + '\n'); return 0; }
      return await launchHost(spec, { cwd, env: context.env ?? process.env });
    } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
  }
  if (command === 'help') {
    (context.out ?? process.stdout).write([
      'Agent Delegation: terminal orchestration inside your coding host',
      '  configure --host codex|claude [--dry-run]; start [--host HOST]',
      '  acp-setup [--check | --install] [--directory DIR] [--json]',
      '  doctor [ID] [--all | --repair] [--json]',
      '  providers [--role NAME | --executor PROVIDER] [--probe] [--json]',
      '  route --role NAME --host HOST',
      '  delegate ASSIGNMENT --role NAME [--executor PROVIDER] [--request-id KEY] [--wait]',
      '  tasks [ID] [--all]; wait ID [--timeout-ms 60000]; watch [ID] [--after N]',
      '  follow-up ID ASSIGNMENT [--executor PROVIDER] [--fresh] [--wait]',
      '  steer ID MESSAGE; interrupt ID; cancel ID',
      '  run TASK | --task-file FILE [--max-workers N] [--resume --supervisor-id ID]',
      '  context-create --context-file FILE; context-show ID; context-update ID --context-file FILE --expected-revision N',
      '  events ID [--after N --wait]; notifications [--ack]',
      'Use --cwd DIR, a stable --session-id ID, and --json for machine-readable output.',
      'Wait/watch budgets never cancel a worker. Executor limits use --timeout-ms on delegate.',
      'Compatibility commands: task, review, status, result, config. See the plugin references for details.',
    ].join('\n') + '\n');
    return 0;
  }
  return runCompanion(argv, { ...context, legacy: false });
}

if (import.meta.main) process.exitCode = await runMain(process.argv.slice(2));
