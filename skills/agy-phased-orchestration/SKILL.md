---
description: Guidance for orchestrating multi-phase agy executions with Claude-in-the-loop synthesis
---

# Phased Orchestration with agy

This skill provides patterns for executing complex work via **phased orchestration** — breaking large tasks into focused phases, delegating each to agy, and synthesizing results between phases.

## When to use phased orchestration

**Use phased execution when:**
- Task has multiple distinct steps that can be verified independently
- Later phases depend on results from earlier phases
- You need to verify intermediate results before proceeding
- The task is too complex for a single agy invocation

**Don't use phased execution when:**
- Task is simple and self-contained
- No intermediate verification needed
- Single-shot execution would work fine

## Pattern: 3-Phase Implementation Flow

**Phase 1: Analyze**
- Scope: Understand the problem, identify root cause
- Output: Structured analysis (files affected, root cause, proposed approach)
- Exit criteria: Root cause identified and approach approved

**Phase 2: Implement**
- Scope: Execute the fix based on Phase 1 analysis
- Input: Phase 1 findings
- Output: Code changes, files modified
- Exit criteria: Tests pass, no errors

**Phase 3: Verify**
- Scope: Run comprehensive tests, check edge cases
- Input: Phase 2 implementation
- Output: Test results, edge case coverage
- Exit criteria: All tests pass, no regressions

## Synthesis gate pattern

Between each phase, YOU synthesize:

```javascript
async function synthesizePhase(phase, result) {
  // 1. Check exit criteria
  const criteriaMet = await verifyExitCriteria(phase, result);
  
  // 2. Extract insights
  const insights = extractInsights(result);
  
  // 3. Decide: continue, pivot, or abort
  if (!criteriaMet) {
    return { 
      abort: true, 
      reason: "Phase 1 didn't identify root cause" 
    };
  }
  
  if (insights.suggests_different_approach) {
    return { 
      abort: false, 
      insights: "Pivot to approach B based on Phase 1 findings" 
    };
  }
  
  return { 
    abort: false, 
    insights: insights.summary 
  };
}
```

## Phase prompt structure

Each phase prompt should include:

1. **Phase goal** — What this phase accomplishes
2. **Context from previous phases** — What we learned so far
3. **Specific task** — What to do in this phase
4. **Exit criteria** — How to know this phase is complete
5. **Output schema** — Structured format for handoff

**Example Phase 1 prompt:**
```
# Phase 1 of 3: Root Cause Analysis

## Context
We've observed that periodic tasks never dispatch in the TriCore simulator.
Previous debugging showed cores 1/2 are stuck in idle.

## Your task
Analyze interrupt routing in tricore_ir.c, tc27xd_soc.c, and tricore_irbus.c.
Identify why CPU1/CPU2 never receive interrupts.

## Exit criteria
- Root cause identified with line numbers
- Proposed fix approach documented
- Files to modify listed

## Output format (JSON schema)
{
  "root_cause": "string",
  "affected_files": ["string"],
  "proposed_approach": "string"
}
```

## Context accumulation

Each phase sees:
- Results from all previous phases
- Synthesis insights from Claude
- Shared context (git state, changed files, etc.)

**Automatic context injection:**
The orchestrator builds this into each phase prompt.

**Manual context injection:**
You can add domain-specific context in synthesis:

```javascript
const synthesis = {
  abort: false,
  insights: `Phase 1 found the bug at line 37. 
             Note: The fix also needs to handle the TC39x variant 
             (different register layout).`
};
```

## Structured handoff with schemas

Define JSON schemas for phase outputs:

```javascript
const ANALYSIS_SCHEMA = {
  type: "object",
  required: ["root_cause", "files_to_modify"],
  properties: {
    root_cause: { type: "string" },
    files_to_modify: { type: "array", items: { type: "string" } },
    proposed_fix: { type: "string" }
  }
};

const phases = [
  {
    name: "Phase 1: Analyze",
    prompt: "...",
    schema: ANALYSIS_SCHEMA,
    exitCriteria: "Root cause identified"
  }
];
```

The orchestrator enforces schemas and parses structured output automatically.

## Error handling

**Phase fails:**
- Orchestrator calls synthesis gate with error
- You decide: abort, retry, or continue

**Exit criteria not met:**
- Synthesis gate should abort or request retry
- Don't proceed to next phase with incomplete work

**Unexpected result:**
- Pivot: inject new context and continue
- Abort: stop execution and report findings

## Usage with /agy:phased-plan

**Define plan file:**
```json
{
  "phases": [
    {
      "name": "Phase 1: Analyze",
      "prompt": "...",
      "schema": {...},
      "exitCriteria": "Root cause identified",
      "model": "gemini-2.0-flash-thinking-exp",
      "effort": "medium"
    },
    {
      "name": "Phase 2: Fix",
      "prompt": "...",
      "exitCriteria": "Tests pass"
    }
  ]
}
```

**Execute:**
```bash
/agy:phased-plan multicore-fix-plan.json
```

**Orchestrator handles:**
- Loading plan
- Executing phases via agy
- Calling you for synthesis between phases
- Accumulating context
- Reporting final results

## Benefits over single-shot execution

✅ **Verification gates** — Catch errors early before wasting tokens
✅ **Context injection** — Steer execution based on intermediate findings
✅ **Adaptive execution** — Pivot when initial approach doesn't work
✅ **Structured handoff** — Clean data flow between phases
✅ **Cost control** — Abort when exit criteria not met

## Anti-patterns

❌ **Too many phases** — Keep it 2-4 phases; more = overhead
❌ **Vague exit criteria** — Make them testable and specific
❌ **No synthesis** — If you don't verify between phases, use single-shot
❌ **Phases without schemas** — Structured output enables clean handoff
❌ **Ignoring failed criteria** — Don't proceed if phase goals unmet

## Comparison to single-shot

**Single-shot (dump entire plan):**
- agy gets the whole plan at once
- You wait for completion or timeout
- No verification gates
- No mid-execution pivots

**Phased orchestration:**
- agy executes one focused phase at a time
- You verify and synthesize between phases
- Can abort/pivot based on intermediate results
- Clean structured handoff

Use phased when verification matters. Use single-shot when speed matters.
