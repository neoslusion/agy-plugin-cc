import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadPrompt(name, pluginRoot) {
  const path = join(pluginRoot, 'prompts', `${name}.md`);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`prompt template not found: ${name} (${path})`);
  }
}

export function renderPrompt(template, vars = {}) {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
