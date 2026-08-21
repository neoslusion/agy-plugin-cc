const STATUS_LABELS = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

function ageLabel(job) {
  const base = job.updatedAt ?? job.createdAt;
  if (!base) return '?';
  const ms = Date.now() - Date.parse(base);
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function durationLabel(job) {
  if (job.durationMs === null || job.durationMs === undefined) return '';
  const s = Math.round(job.durationMs / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function renderStatusTable(snapshot) {
  const { jobs } = snapshot;
  if (jobs.length === 0) return 'No jobs yet. Run `/agy:task "..."` to delegate work.';
  const rows = jobs.map((j) => {
    const id = j.id.length > 28 ? j.id.slice(0, 25) + '...' : j.id;
    return `| \`${id}\` | ${j.kindLabel} | ${j.executor} | ${STATUS_LABELS[j.status] ?? j.status} | ${j.phase} | ${ageLabel(j)} |`;
  });
  return ['| Job | Kind | Executor | Status | Phase | Age |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function renderJobDetail(job) {
  const lines = [
    `## Job ${job.id}`,
    '',
    `- Kind: ${job.kindLabel} (${job.kind})`,
    `- Executor: ${job.executor}`,
    `- Status: ${job.status} — phase ${job.phase}`,
    `- Workspace: \`${job.workspaceRoot}\``,
    `- Session: ${job.sessionId ?? '(none)'}`,
    `- Created: ${job.createdAt}`,
  ];
  if (job.startedAt) lines.push(`- Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`- Completed: ${job.completedAt}`);
  if (job.pid) lines.push(`- PID: ${job.pid}`);
  if (job.conversationId) lines.push(`- Conversation: \`${job.conversationId}\``);
  if (job.logFile) lines.push(`- Log: \`${job.logFile}\``);
  if (job.errorMessage) lines.push(`- Error: ${job.errorMessage}`);
  lines.push('');
  lines.push('### Request');
  lines.push('');
  lines.push(typeof job.request === 'string' ? job.request : JSON.stringify(job.request, null, 2));
  if (job.result !== null && job.result !== undefined) {
    lines.push('');
    lines.push('### Result');
    lines.push('');
    lines.push(renderResult(job.result));
  }
  return lines.join('\n');
}

export function renderResult(result) {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '(no result)';
  if (typeof result === 'object' && Array.isArray(result.findings)) {
    const lines = [`Verdict: **${result.verdict ?? 'unknown'}**`];
    if (result.summary) lines.push('', 'Summary:', '', String(result.summary));
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
    const findings = [...result.findings].sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
    if (findings.length) {
      lines.push('', 'Findings:', '');
      for (const f of findings) {
        const loc = f.file ? ` (\`${f.file}${f.line_start ? `:${f.line_start}` : ''}\`)` : '';
        lines.push(`- **[${f.severity}]** ${f.title}${loc}${f.confidence !== undefined ? ` — confidence ${f.confidence}` : ''}`);
        if (f.body) lines.push(`  ${String(f.body).split('\n').join('\n  ')}`);
        if (f.recommendation) lines.push(`  **Recommendation:** ${f.recommendation}`);
      }
    }
    if (Array.isArray(result.next_steps) && result.next_steps.length) {
      lines.push('', 'Next steps:', '');
      for (const s of result.next_steps) lines.push(`- ${s}`);
    }
    return lines.join('\n');
  }
  return JSON.stringify(result, null, 2);
}
