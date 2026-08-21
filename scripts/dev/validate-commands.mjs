import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'commands';
let ok = true;
const files = readdirSync(dir).filter((x) => x.endsWith('.md')).sort();
for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) {
    console.log('NO FRONTMATTER:', f);
    ok = false;
    continue;
  }
  const body = raw.slice(m[0].length);
  const kv = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const missing = ['description', 'disable-model-invocation'].filter((k) => !(k in kv));
  const hasArgs = body.includes('$ARGUMENTS');
  const hasCompanion = body.includes('agy-companion.mjs');
  if (missing.length || !hasArgs || !hasCompanion) {
    console.log('BAD:', f, { missing, hasArgs, hasCompanion });
    ok = false;
  }
}
console.log(`${ok ? 'ALL' : 'SOME'} ${files.length} COMMAND FILES VALID`);
process.exit(ok ? 0 : 1);
