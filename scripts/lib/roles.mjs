export const ROLE_CONTRACTS = {
  planner: { readOnly: true, description: 'Investigate a requested change and propose a bounded implementation plan.', instructions: 'Identify the relevant code, dependencies, decisions, and acceptance criteria. Propose an actionable plan. Do not implement it.' },
  advisor: { readOnly: true, description: 'Give a second opinion on a specific design decision or blocker.', instructions: 'Examine the supplied evidence, compare the meaningful alternatives, and recommend a next step with its tradeoffs. Do not expand the assignment or implement changes.' },
  executor: { readOnly: false, description: 'Implement a scoped coding task with explicit ownership.', instructions: 'Implement the assigned outcome within the supplied scope. Follow existing patterns. Run focused checks when useful and coordinate shared validation with the parent. Report decisions requiring broader scope instead of making them independently.' },
  reviewer: { readOnly: true, description: 'Independently inspect changes for concrete defects and regressions.', instructions: 'Inspect the actual changes and surrounding behavior. Report actionable findings with severity, file or symbol, evidence, and a fix or validation step. Distinguish defects from uncertainty. Do not edit files.' },
  explorer: { readOnly: true, description: 'Locate code paths, constraints, and tests for a specific question.', instructions: 'Trace the relevant behavior and return file and symbol references, constraints, and uncertainty. Keep exploration bounded. Do not edit files.' },
  monitor: { readOnly: true, description: 'Assess a task failure, blocker, or conflicting evidence for the orchestrator.', instructions: 'Inspect the supplied context revision, task events, and evidence. Identify the concrete intervention needed, stale assumptions, missing checks, or conflicts. Return a concise recommendation to the parent. Do not edit files, grant permissions, launch workers, or change acceptance criteria. Routine process tracking is handled by code; do not poll or wait.' },
  tester: { readOnly: false, description: 'Reproduce and verify the assigned behavior using focused checks.', instructions: 'Use existing tooling to reproduce the behavior and run relevant checks. Report commands, outcomes, and coverage gaps. Edit tests only when assigned; do not change production code to make checks pass.' },
};

const ALIASES = { plan: 'planner', advise: 'advisor', implement: 'executor', review: 'reviewer', explore: 'explorer', test: 'tester' };

export function roleContract(name, role = {}) {
  const purpose = role.purpose ?? ALIASES[name] ?? (Object.hasOwn(ROLE_CONTRACTS, name) ? name : 'executor');
  const contract = ROLE_CONTRACTS[purpose];
  if (!contract) throw new Error(`Unknown role purpose: ${purpose}`);
  return {
    purpose,
    readOnly: contract.readOnly,
    description: contract.description,
    instructions: [
      'You are a delegated worker. Perform this assignment directly; do not invoke the delegation plugin or spawn more workers.',
      contract.instructions,
      role.instructions,
      'Return a concise handoff: outcome, changed files or evidence references, checks performed and their results, and remaining blockers. A completed turn is not proof that acceptance criteria are met.',
    ].filter(Boolean).join('\n\n'),
  };
}

export function nativeAgentName(role) { return `delegation-${role}`; }
