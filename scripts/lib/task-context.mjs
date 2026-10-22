import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs.mjs';
import { generateJobId, isoNow } from './state.mjs';
import { artifactId, withArtifactLock } from './artifact-store.mjs';

const FIELDS = new Set(['objective', 'acceptanceCriteria', 'decisions', 'ownership', 'evidence', 'blockers', 'plan', 'baseCommit']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = (root, id) => join(root, 'contexts', artifactId(id));
const pathFor = (root, id, revision) => join(directory(root, id), `${revision}.json`);

function payload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task context must be an object');
  for (const key of Object.keys(value)) if (!FIELDS.has(key)) throw new Error(`Unknown context field: ${key}`);
  if (typeof value.objective !== 'string' || !value.objective.trim()) throw new Error('Context requires an objective');
  for (const key of ['acceptanceCriteria', 'decisions', 'evidence', 'blockers']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string'))) throw new Error(`context.${key} must be an array of strings`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('Task context exceeds 128 KiB');
  return JSON.parse(JSON.stringify(value));
}

export function readTaskContext(root, id, revision = null) {
  if (revision === null) {
    const versions = readdirSync(directory(root, id)).filter(name => /^\d+\.json$/.test(name)).map(name => Number(name.slice(0, -5)));
    revision = Math.max(0, ...versions);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid context revision');
  const record = JSON.parse(readFileSync(pathFor(root, id, revision), 'utf8'));
  if (record.id !== id || record.revision !== revision || record.hash !== digest(record.payload)) throw new Error('Context integrity check failed');
  return record;
}

export function createTaskContext(root, value, id = generateJobId('context')) {
  return withArtifactLock(directory(root, id), () => {
    if (readdirSync(directory(root, id)).some(name => /^\d+\.json$/.test(name))) throw new Error(`Context already exists: ${id}`);
    const content = payload(value);
    const record = { version: 1, id, revision: 1, hash: digest(content), createdAt: isoNow(), payload: content };
    writeJsonAtomic(pathFor(root, id, 1), record);
    return record;
  });
}

export function reviseTaskContext(root, id, patch, expectedRevision) {
  return withArtifactLock(directory(root, id), () => {
    const previous = readTaskContext(root, id);
    if (previous.revision !== expectedRevision) throw new Error(`Stale context revision: expected ${expectedRevision}, current ${previous.revision}`);
    const content = payload({ ...previous.payload, ...patch });
    const record = { version: 1, id, revision: previous.revision + 1, hash: digest(content), createdAt: isoNow(), payload: content };
    writeJsonAtomic(pathFor(root, id, record.revision), record);
    return record;
  });
}

export function contextReference(record) { return { id: record.id, revision: record.revision, hash: record.hash }; }

export function contextPrompt(root, reference, { ownedFiles = [], maxChars = 24 * 1024 } = {}) {
  const record = readTaskContext(root, reference.id, reference.revision);
  if (reference.hash && reference.hash !== record.hash) throw new Error('Context reference hash mismatch');
  const content = { ...record.payload };
  if (ownedFiles.length) content.ownership = { assigned: ownedFiles, all: content.ownership };
  const text = JSON.stringify(content, null, 2);
  return `Shared task context ${record.id}, revision ${record.revision}, SHA-256 ${record.hash}.\nSource: ${pathFor(root, record.id, record.revision)}\nThis is a fixed snapshot. Report new decisions and blockers in your result; the parent owns context updates.\n${text.length > maxChars ? text.slice(0, maxChars) + '\n[context excerpt truncated; ask the parent for specific missing evidence]' : text}`;
}
