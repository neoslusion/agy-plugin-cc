import { agyExecutor } from './agy.mjs';

const REGISTRY = { agy: agyExecutor };

export function get(id) {
  const executor = REGISTRY[id];
  if (!executor) {
    throw new Error(`unknown executor "${id}" (known: ${Object.keys(REGISTRY).join(', ')})`);
  }
  return executor;
}

export function list() {
  return Object.values(REGISTRY).map((e) => ({ id: e.id, binary: e.binary }));
}
