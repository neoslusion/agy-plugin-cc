#!/usr/bin/env node
// Scripted stub of the agy CLI for fully offline tests.
// Activated via AGY_BINARY (or options.binary) pointing at this file's .cmd wrapper.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const prompt = val('-p') ?? '';
const format = val('--output-format') ?? 'text';
const schemaPath = val('--json-schema');
const scenario = (() => {
  try {
    return JSON.parse(process.env.FAKE_AGY_SCENARIO ?? '{}');
  } catch {
    return {};
  }
})();

const status = scenario.status ?? 'SUCCESS';
const response = scenario.response ?? (status === 'SUCCESS' ? 'PONG\n' : '');
const error = scenario.error ?? null;
const conversationId = scenario.conversationId ?? 'fake-conv-1';
const notice = scenario.notice ?? null;
const delayMs = scenario.delayMs ?? 0;

let structured = null;
let schema = null;
if (schemaPath) {
  schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const props = Object.keys(schema.properties ?? {});
  if (props.includes('decision')) {
    structured = { decision: scenario.decision ?? 'ALLOW', reason: scenario.reason ?? 'fixture reason' };
  } else if (props.includes('verdict')) {
    structured = { verdict: 'approve', summary: 'fixture summary', findings: [], next_steps: [] };
  } else {
    structured = {};
  }
}

const envelope = {
  conversation_id: conversationId,
  status,
  response,
  duration_seconds: 0.01,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
};
if (error !== null) envelope.error = error;
if (structured) {
  envelope.structured_output = structured;
  envelope.json_schema = schema;
}

const emit = () => {
  if (format === 'stream-json') {
    console.log(JSON.stringify({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'request-review' } }));
    if (scenario.toolStep) {
      console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: scenario.toolStep } } } }));
    }
    console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: response } }));
    console.log(JSON.stringify({ event: 'result', result: envelope }));
  } else if (format === 'json') {
    console.log(JSON.stringify(envelope));
  } else {
    process.stdout.write(response);
  }
  if (notice) process.stderr.write(notice);
  process.exit(status === 'SUCCESS' ? 0 : 1);
};

if (delayMs > 0) setTimeout(emit, delayMs);
else emit();
