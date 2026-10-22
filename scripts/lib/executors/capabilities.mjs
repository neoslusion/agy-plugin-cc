const RICH = {
  'app-server': { executor: 'codex', resume: true, structuredOutput: true, steering: true, interrupt: true, approvals: true },
  'agent-sdk': { executor: 'claude', resume: true, structuredOutput: true, steering: true, interrupt: true, approvals: true },
  acp: { executor: 'agy', resume: true, structuredOutput: false, steering: false, interrupt: true, approvals: true },
};

export function executorCapabilities(executor, integration = 'cli') {
  if (integration === 'cli') return { executor, integration, resume: true, structuredOutput: true, steering: false, interrupt: false, approvals: false };
  const capabilities = RICH[integration];
  if (!capabilities || capabilities.executor !== executor) throw new Error(`${executor} does not support integration ${integration}`);
  return { ...capabilities, integration };
}

export function requireCapabilities(executor, options) {
  const capabilities = executorCapabilities(executor, options.integration);
  if (options.jsonSchema && !capabilities.structuredOutput) throw new Error(`${capabilities.integration} does not support schema-constrained output; select cli for structured supervisor tasks`);
  if (options.agent && capabilities.integration !== 'cli') throw new Error('--agent is only supported by cli integration');
  return capabilities;
}
