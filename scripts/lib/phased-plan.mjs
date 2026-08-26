import { AgyBrokerClient } from './rpc-client.mjs';
import { ensureBrokerSession } from './broker-lifecycle.mjs';
import { buildArgs } from './executors/agy.mjs';

/**
 * Execute a multi-phase plan with synthesis gates between phases.
 * Claude stays in the loop to verify results and inject context.
 */
export async function executePlanPhased({
  phases,
  cwd,
  onPhaseComplete,
  onProgress = () => {},
  sharedContext = {}
}) {
  if (!phases || phases.length === 0) {
    throw new Error('No phases provided for phased execution');
  }

  let conversationId = null;
  const results = [];

  for (const [i, phase] of phases.entries()) {
    const phaseNum = i + 1;
    onProgress({ type: 'phase-start', phase: phaseNum, name: phase.name });

    // Build phase prompt with accumulated context
    const prompt = renderPhasePrompt(phase, {
      ...sharedContext,
      previousResults: results,
      phaseNumber: phaseNum,
      totalPhases: phases.length
    });

    try {
      // Execute phase via broker (maintains conversation thread)
      const session = await ensureBrokerSession(cwd);
      const client = await AgyBrokerClient.connect(cwd, { session });

      try {
        const args = buildArgs({
          job: { jobClass: 'task' },
          prompt,
          options: {
            model: phase.model,
            effort: phase.effort,
            conversation: conversationId,
            approveAll: true,
            jsonSchema: phase.schema ? JSON.stringify(phase.schema) : null,
            outputFormat: 'stream-json'
          }
        });

        // Set up progress tracking
        client.setNotificationHandler((message) => {
          if (message.method === 'agy/notification' && message.params?.event === 'step_update') {
            const step = message.params.step_update;
            if (step.step_type === 'tool' && step.state === 'ACTIVE') {
              onProgress({
                type: 'phase-progress',
                phase: phaseNum,
                tool: step.tool_name
              });
            }
          }
        });

        const brokerResult = await client.request('agy/run', { args });

        // Parse result
        let phaseResult = {
          phase: phaseNum,
          name: phase.name,
          status: brokerResult.status,
          response: brokerResult.stdout ?? '',
          error: brokerResult.stderr ?? null,
          exitCode: brokerResult.exitCode ?? null
        };

        // If schema was provided, parse structured output
        if (phase.schema && phaseResult.response) {
          try {
            phaseResult.structured = JSON.parse(phaseResult.response);
          } catch {
            phaseResult.parseError = 'Failed to parse structured output';
          }
        }

        results.push(phaseResult);

        // Check exit criteria
        if (phase.exitCriteria) {
          const criteriaCheck = await checkExitCriteria(phase.exitCriteria, phaseResult, cwd);
          phaseResult.criteriasMet = criteriaCheck.met;
          phaseResult.criteriasDetails = criteriaCheck.details;
        }

        onProgress({ type: 'phase-complete', phase: phaseNum, result: phaseResult });

        // Synthesis gate: let orchestrator decide next step
        if (onPhaseComplete) {
          const synthesis = await onPhaseComplete(phase, phaseResult, {
            phaseNumber: phaseNum,
            totalPhases: phases.length,
            previousResults: results
          });

          if (synthesis.abort) {
            return {
              completed: phaseNum,
              aborted: true,
              reason: synthesis.reason ?? 'Orchestrator aborted execution',
              results
            };
          }

          // Inject synthesis insights into shared context
          sharedContext.synthesis = synthesis.insights ?? null;
        }

        // Extract conversation ID for thread continuity
        // (agy may not expose this directly, so this is aspirational)
        // conversationId = brokerResult.conversationId ?? conversationId;

      } finally {
        await client.close();
      }

    } catch (err) {
      onProgress({
        type: 'phase-error',
        phase: phaseNum,
        error: err.message
      });

      results.push({
        phase: phaseNum,
        name: phase.name,
        status: 'failed',
        error: err.message
      });

      // Let orchestrator decide whether to continue or abort
      if (onPhaseComplete) {
        const synthesis = await onPhaseComplete(phase, results[results.length - 1], {
          phaseNumber: phaseNum,
          totalPhases: phases.length,
          previousResults: results,
          error: err
        });

        if (synthesis.abort) {
          return {
            completed: phaseNum,
            aborted: true,
            reason: synthesis.reason ?? `Phase ${phaseNum} failed: ${err.message}`,
            results
          };
        }
      } else {
        // No orchestrator, abort on error
        return {
          completed: phaseNum,
          aborted: true,
          reason: `Phase ${phaseNum} failed: ${err.message}`,
          results
        };
      }
    }
  }

  return {
    completed: phases.length,
    aborted: false,
    results
  };
}

function renderPhasePrompt(phase, context) {
  let prompt = `# Phase ${context.phaseNumber} of ${context.totalPhases}: ${phase.name}\n\n`;

  if (phase.description) {
    prompt += `${phase.description}\n\n`;
  }

  // Inject context from previous phases
  if (context.previousResults && context.previousResults.length > 0) {
    prompt += `## Previous phases:\n\n`;
    for (const prev of context.previousResults) {
      const summary = prev.structured
        ? JSON.stringify(prev.structured, null, 2).slice(0, 300)
        : prev.response.slice(0, 300);
      prompt += `- Phase ${prev.phase}: ${prev.name} (${prev.status})\n`;
      prompt += `  ${summary}${summary.length >= 300 ? '...' : ''}\n\n`;
    }
  }

  // Inject synthesis insights from orchestrator
  if (context.synthesis) {
    prompt += `## Insights from previous analysis:\n\n${context.synthesis}\n\n`;
  }

  prompt += `## Your task:\n\n${phase.prompt}\n\n`;

  if (phase.exitCriteria) {
    prompt += `## Exit criteria:\n\n${phase.exitCriteria}\n\n`;
  }

  if (phase.schema) {
    prompt += `Your output must conform to the provided JSON schema.\n`;
  }

  return prompt;
}

async function checkExitCriteria(criteria, phaseResult, cwd) {
  // Simple exit criteria checking
  // In a full implementation, this could run tests, check files, etc.

  if (criteria.includes('test') || criteria.includes('passes')) {
    // Check if any tests were mentioned in the response
    const hasTests = phaseResult.response.toLowerCase().includes('test');
    return {
      met: hasTests,
      details: hasTests ? 'Tests mentioned in output' : 'No test execution found'
    };
  }

  // Default: assume criteria met if phase completed successfully
  return {
    met: phaseResult.status === 'completed',
    details: phaseResult.status === 'completed'
      ? 'Phase completed successfully'
      : 'Phase failed or incomplete'
  };
}
