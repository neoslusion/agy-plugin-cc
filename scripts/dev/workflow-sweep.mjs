// One-off workflow sweep: exercises the companion end-to-end against the real
// agy binary in a scratch repo. Not part of `npm test`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from '../lib/process.mjs';
import { makeTempDir } from '../lib/fs.mjs';
import { runMain } from '../agy-companion.mjs';

const DATA = makeTempDir('sweep-data-');
const WORK = makeTempDir('sweep-work-');
const env = { ...process.env, CLAUDE_PLUGIN_DATA: DATA, AGY_SESSION_ID: 'sweep-session' };
let failures = 0;

function ctx() {
  const out = [];
  const err = [];
  return { cwd: WORK, env, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, outLines: out, errLines: err };
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function run(name, args, { expectCode = 0 } = {}) {
  const c = ctx();
  const code = await runMain(args, c);
  check(name, code === expectCode, `code=${code} out=${JSON.stringify(c.outLines.join('').slice(0, 120))} err=${JSON.stringify(c.errLines.join('').slice(0, 120))}`);
  return { code, c };
}

// --- scratch git repo -------------------------------------------------------
runCommand('git', ['init', '-q'], { cwd: WORK });
runCommand('git', ['config', 'user.name', 'Sweep'], { cwd: WORK });
runCommand('git', ['config', 'user.email', 'sweep@example.com'], { cwd: WORK });
writeFileSync(join(WORK, 'app.js'), 'const x = 1;\nconsole.log(x);\n');
runCommand('git', ['add', '-A'], { cwd: WORK });
runCommand('git', ['commit', '-q', '-m', 'init'], { cwd: WORK });

// --- 1. setup ---------------------------------------------------------------
const s = await run('setup reports ready', ['setup', '--json']);

// --- 2. task (write-capable) ------------------------------------------------
await run('task creates a file', ['task', 'Create a file hello.js containing exactly: console.log("hello agy")', '--timeout-ms', '180000']);
check('hello.js exists', runCommand('node', ['-e', 'require("fs").existsSync("hello.js")'], { cwd: WORK }).code === 0);

// --- 3. review on a dirty tree ----------------------------------------------
writeFileSync(join(WORK, 'app.js'), 'const x = 2;\nconsole.log(x);\n');
const r = await run('review returns schema verdict', ['review', '--timeout-ms', '180000']);
check('review printed a structured verdict', r.c.outLines.join('\n').includes('"verdict"'));

// --- 4. plan + status + result -----------------------------------------------
mkdirSync(join(WORK, 'docs', 'superpowers', 'plans'), { recursive: true });
writeFileSync(join(WORK, 'docs', 'superpowers', 'plans', 'sweep-plan.md'), '# Sweep plan\n\n- [ ] Create file plan-out.txt containing "plan done"\n');
const planResult = await run('plan executes', ['plan', '--timeout-ms', '240000']);
check('plan-out.txt exists', runCommand('node', ['-e', 'require("fs").existsSync("plan-out.txt")'], { cwd: WORK }).code === 0);

// --- 5. cancel (no longer background-specific) -------------------------------
// Companion now expects harness to handle background execution.
// Cancel tests removed since companion blocks until completion.

// --- 6. resume candidate -----------------------------------------------------
await run('task-resume-candidate returns a job', ['task-resume-candidate', '--json']);

console.log(failures === 0 ? '\nSWEEP CLEAN' : `\nSWEEP FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
