---
description: Execute a multi-phase plan with Claude-in-the-loop synthesis between phases
argument-hint: '[<plan-file>] [--model <model>] [--effort <level>]'
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash(node:*), AskUserQuestion
---

Execute a multi-phase plan step-by-step with Claude synthesizing results between phases.

This command enables **phased orchestration** where each phase executes via agy, returns structured output, and Claude verifies exit criteria before proceeding to the next phase.

Raw slash-command arguments:
`$ARGUMENTS`

## Plan resolution

1. If `$ARGUMENTS` names an existing plan file, load it
2. If `$ARGUMENTS` is empty, look for newest plan under `docs/superpowers/plans/`
3. Plan must contain a `phases` array with structure:
   ```json
   {
     "phases": [
       {
         "name": "Phase 1: Analyze",
         "description": "Optional description",
         "prompt": "Analyze multicore IRQ routing...",
         "schema": {...},
         "exitCriteria": "Root cause identified",
         "model": "optional-model-override",
         "effort": "optional-effort-override"
       }
     ]
   }
   ```

## Execution flow

For each phase:
1. **Prepare context** - Inject results from previous phases
2. **Delegate to agy** - Execute via `Agent(subagent_type: "agy:plan-phase")`
3. **Verify exit criteria** - Check if phase goals were met
4. **Synthesize** - Extract insights, decide whether to continue/abort
5. **Inject context** - Pass synthesis to next phase

Between phases, YOU (Claude) synthesize:
- Did the phase meet its exit criteria?
- What insights should inform the next phase?
- Should execution continue or abort?

## Synthesis gate pattern

After each phase completion:
```javascript
const synthesis = {
  exitCriteriaMet: true/false,
  insights: "What we learned from this phase",
  abort: false,  // or true to stop execution
  reason: "Why we're aborting (if abort=true)"
};
```

## Usage examples

**Simple 2-phase plan:**
```bash
/agy:phased-plan analyze-and-fix.json
```

**Inline phase definition:**
If no plan file provided, prompt the user to define phases or point to a plan file.

## What this enables

- **Verification gates** - Ensure each phase completes successfully before proceeding
- **Context accumulation** - Each phase sees results from previous phases
- **Adaptive execution** - Abort or pivot based on intermediate results
- **Structured handoff** - Schema-enforced output between phases

This is the "fan-out with synthesis" pattern: agy executes phases, Claude orchestrates.
