export const BOOL_FLAGS = new Set([
  'wait',
  'background',
  'resume',
  'fresh',
  'all',
  'json',
  'enable-review-gate',
  'disable-review-gate',
  'enable-approve-all',
  'disable-approve-all',
  'approve-all',
  'integrate',
  'allow-dirty',
  'ack',
]);

export const VALUE_FLAGS = new Set([
  'base',
  'scope',
  'model',
  'effort',
  'agent',
  'conversation',
  'timeout-ms',
  'executor',
  'print-timeout',
  'json-schema',
  'config',
  'role',
  'prompt-file',
  'cwd',
  'session-id',
  'task-file',
  'max-iterations',
  'max-workers',
  'supervisor-id',
  'integration',
  'context-id',
  'context-revision',
  'expected-revision',
  'context-file',
  'after',
  'message-file',
  'request-id',
  'wait-timeout-ms',
]);

export function parseArgs(argv, { extraBool = [], extraValue = [] } = {}) {
  const bools = new Set([...BOOL_FLAGS, ...extraBool]);
  const values = new Set([...VALUE_FLAGS, ...extraValue]);
  const opts = {};
  const positionals = [];
  let parsing = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (parsing && arg === '--') {
      parsing = false;
      continue;
    }
    if (parsing && arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
      if (bools.has(name)) {
        if (inlineValue !== null && inlineValue !== 'true' && inlineValue !== 'false') {
          throw new Error(`flag --${name} does not take a value`);
        }
        opts[name] = inlineValue !== null ? inlineValue === 'true' : true;
      } else if (name.startsWith('no-') && bools.has(name.slice(3))) {
        if (inlineValue !== null) {
          throw new Error(`flag --${name} does not take a value`);
        }
        opts[name.slice(3)] = false;
      } else if (values.has(name)) {
        opts[name] = inlineValue ?? argv[++i];
        if (opts[name] === undefined) throw new Error(`flag --${name} requires a value`);
      } else {
        opts.unknown = opts.unknown ?? [];
        opts.unknown.push(inlineValue !== null ? `${name}=${inlineValue}` : name);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { opts, positionals };
}
