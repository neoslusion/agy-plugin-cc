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

        // Extract user and assistant turns
        if (entry.type === "user_message" && entry.content) {
          turns.push({
            role: "user",
            content: extractTextFromContent(entry.content),
            timestamp: entry.timestamp
          });
        } else if (entry.type === "assistant_message" && entry.content) {
          turns.push({
            role: "assistant",
            content: extractTextFromContent(entry.content),
            timestamp: entry.timestamp
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Apply filters
    const maxTurns = options.maxTurns ?? 10;
    const recentTurns = turns.slice(-maxTurns);

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

export function buildContextPrompt(claudeContext, taskPrompt) {
  if (!claudeContext || !claudeContext.turns || claudeContext.turns.length === 0) {
    return taskPrompt;
  }

  const contextSummary = claudeContext.turns
    .slice(-5) // Last 5 turns
    .map(turn => {
      const content = turn.content.slice(0, 200); // Truncate long messages
      return `${turn.role}: ${content}${turn.content.length > 200 ? '...' : ''}`;
    })
    .join("\n\n");

  return `## Context from Claude Code session

Recent conversation (last ${claudeContext.turns.slice(-5).length} turns):

${contextSummary}

---

## Current task

${taskPrompt}`;
}
