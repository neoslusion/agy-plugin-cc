import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TRANSCRIPT_PATH_ENV = "AGY_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    return null; // No transcript available
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  try {
    source = fs.realpathSync(sourcePath);
  } catch {
    return null; // File doesn't exist
  }

  return source;
}

export function extractClaudeContext(transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    const turns = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Extract user and assistant turns. Claude transcripts nest the payload
        // under `message` ({ role, content }); older shapes put content at the
        // top level, so accept both.
        const role = entry.type === "user" ? "user" : entry.type === "assistant" ? "assistant" : null;
        if (role) {
          const rawContent = entry.message?.content ?? entry.content;
          const content = rawContent ? extractTextFromContent(rawContent) : "";
          if (content.trim()) {
            turns.push({ role, content, timestamp: entry.timestamp });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // A plain tail slice drops the user's ask on tool-heavy sessions, where the
    // last N entries are all short assistant narration. Keep the recent user
    // turns even when they fall outside the window.
    const maxTurns = options.maxTurns ?? 10;
    const recentTurns = selectContextTurns(turns, maxTurns);

    return {
      turns: recentTurns,
      totalTurns: turns.length
    };
  } catch (err) {
    return null;
  }
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === "string") return block;
        if (block.type === "text" && block.text) return block.text;
        if (block.type === "thinking" && block.thinking) return `[thinking: ${block.thinking.slice(0, 100)}...]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

const CONTEXT_WINDOW = 5;
const NARRATION_MAX_CHARS = 100;
const MIN_USER_TURNS = 2;

// A naive tail window is wrong for tool-heavy sessions: those produce long runs
// of short assistant narration ("Now the broker fix."), so the last N turns can
// be entirely status lines with no user intent in them. Prefer substantive turns
// and guarantee the recent user turns survive.
export function selectContextTurns(turns, windowSize = CONTEXT_WINDOW) {
  const indexed = turns.map((turn, index) => ({ ...turn, index }));

  const substantive = indexed.filter(
    (t) => t.role === 'user' || t.content.length > NARRATION_MAX_CHARS
  );
  const pool = substantive.length >= windowSize ? substantive : indexed;
  const selected = new Map(pool.slice(-windowSize).map((t) => [t.index, t]));

  // Backfill when the window still came out short on user turns. This can push
  // the window one or two over windowSize; carrying the ask is worth more than
  // holding the size exactly.
  const countUsers = () => [...selected.values()].filter((t) => t.role === 'user').length;
  for (const turn of indexed.filter((t) => t.role === 'user').slice(-MIN_USER_TURNS)) {
    if (countUsers() >= MIN_USER_TURNS) break;
    selected.set(turn.index, turn);
  }

  return [...selected.values()].sort((a, b) => a.index - b.index);
}

export function buildContextPrompt(claudeContext, taskPrompt) {
  if (!claudeContext || !claudeContext.turns || claudeContext.turns.length === 0) {
    return taskPrompt;
  }

  const window = selectContextTurns(claudeContext.turns);
  if (window.length === 0) {
    return taskPrompt;
  }

  const contextSummary = window
    .map(turn => {
      const content = turn.content.slice(0, 200); // Truncate long messages
      return `${turn.role}: ${content}${turn.content.length > 200 ? '...' : ''}`;
    })
    .join("\n\n");

  return `## Context from Claude Code session

Recent conversation (${window.length} turns):

${contextSummary}

---

## Current task

${taskPrompt}`;
}
