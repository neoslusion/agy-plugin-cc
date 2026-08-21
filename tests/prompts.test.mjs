import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrompt, renderPrompt } from '../scripts/lib/prompts.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const TEMPLATES = ['review', 'adversarial-review', 'stop-review-gate', 'plan-execution'];

const VARS = {
  review: { TARGET_LABEL: 'working tree', REVIEW_COLLECTION_GUIDANCE: 'Files changed: a.txt', REVIEW_INPUT: '--- a.txt\n+++ b.txt\n+hello\n' },
  'adversarial-review': { TARGET_LABEL: 'auth module', USER_FOCUS: 'focus on auth', REVIEW_COLLECTION_GUIDANCE: 'Files changed: auth.mjs', REVIEW_INPUT: 'diff here' },
  'stop-review-gate': { CLAUDE_RESPONSE_BLOCK: 'I refactored the parser and the tests pass.' },
  'plan-execution': { PLAN_TEXT: '# Step 1: add endpoint\n\n- [ ] implement\n' },
};

function loadSchema(name) {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'schemas', `${name}.schema.json`), 'utf8'));
}

test('schema files are valid JSON and parse as draft 2020-12', () => {
  for (const name of ['review-output', 'stop-gate']) {
    const schema = loadSchema(name);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.ok(schema.required.length > 0);
  }
});

test('all templates render with no leftover placeholders', () => {
  for (const name of TEMPLATES) {
    const rendered = renderPrompt(loadPrompt(name, PLUGIN_ROOT), VARS[name]);
    assert.ok(!/{{[A-Z0-9_]+}}/.test(rendered), `${name} left placeholders unrendered`);
    assert.ok(rendered.length > 100, `${name} renders too short`);
  }
});

test('review templates spell out every required schema field (drift guard)', () => {
  const schema = loadSchema('review-output');
  for (const name of ['review', 'adversarial-review']) {
    const rendered = renderPrompt(loadPrompt(name, PLUGIN_ROOT), VARS[name]);
    for (const field of schema.required) {
      assert.ok(rendered.includes(field), `${name} prompt lost schema field "${field}"`);
    }
    const itemProps = Object.keys(schema.properties.findings.items.properties);
    for (const field of itemProps) {
      assert.ok(rendered.includes(field), `${name} prompt lost findings field "${field}"`);
    }
  }
});

test('stop-review-gate prompt spells out ALLOW/BLOCK contract', () => {
  const rendered = renderPrompt(loadPrompt('stop-review-gate', PLUGIN_ROOT), VARS['stop-review-gate']);
  const schema = loadSchema('stop-gate');
  assert.ok(rendered.includes(schema.properties.decision.enum[0]));
  assert.ok(rendered.includes(schema.properties.decision.enum[1]));
});

test('plan-execution template carries plan text and step discipline', () => {
  const rendered = renderPrompt(loadPrompt('plan-execution', PLUGIN_ROOT), VARS['plan-execution']);
  assert.ok(rendered.includes('Step 1: add endpoint'));
  assert.ok(rendered.includes('step-by-step'));
});
