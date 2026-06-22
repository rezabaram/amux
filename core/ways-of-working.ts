/**
 * amux — Ways of Working (WoW) helpers.
 *
 * WoW is the editable team collaboration contract stored as Markdown in
 * artifacts/project/WOW.md. It extends the built-in COMMON_PRINCIPLES with
 * project-specific norms. Injected into agent prompts by adapters.
 *
 * WoW is distinct from project context (CONTEXT.md = vision/strategy).
 * WoW = how we collaborate; context = what we're building.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirSync, sessionFile } from "./storage.ts";

export const WOW_FILENAME = "WOW.md";
export const DEFAULT_WOW_PREVIEW_LIMIT = 4096;

export const DEFAULT_WAYS_OF_WORKING = `# Ways of Working

## Communication
- Use task comments for task-scoped coordination and review discussion; comments notify relevant subscribers by default.
- Use direct messages only for exceptional non-task communication.

## Review and definition of done
- Substantive implementation should go to review before done.
- Review from the task/spec, diff, tests, and handoff summary.
- Done means reviewed, integrated, verified, and risks reported.

## Waiting and reminders
- When waiting on another agent or a time-based condition, leave a clear task comment with what you are waiting for and, when useful, a suggested check-in time.
- Do not run periodic wake loops by default.
- On each turn after being notified or after idle time, reassess current task state/comments before proceeding.

## Learning
- Record durable decisions, learnings, and important progress in the journal.
- Keep learnings curated and forward-looking; raw history belongs in task comments and git.`;

// ─── Paths ───────────────────────────────────────────────────

function projectArtifactsPath(session: string): string {
  return sessionFile(session, "artifacts", "project");
}

export function wowPath(session: string): string {
  return join(projectArtifactsPath(session), WOW_FILENAME);
}

// ─── Operations ──────────────────────────────────────────────

export function readWaysOfWorking(
  session: string,
  maxLength = DEFAULT_WOW_PREVIEW_LIMIT,
): string | null {
  const path = wowPath(session);
  if (!existsSync(path)) return null;
  try {
    let content = readFileSync(path, "utf8").trim();
    if (maxLength > 0 && content.length > maxLength) {
      content = content.slice(0, maxLength) + `\n\n[truncated -- see full file at ${path}]`;
    }
    return content || null;
  } catch {
    return null;
  }
}

export function writeWaysOfWorking(session: string, content: string): string {
  const path = wowPath(session);
  ensureDirSync(projectArtifactsPath(session));
  writeFileSync(path, content, "utf8");
  return path;
}

/** Create a default WOW.md for a new project if none exists. */
export function ensureDefaultWaysOfWorking(session: string): string {
  const path = wowPath(session);
  if (existsSync(path)) return path;
  return writeWaysOfWorking(session, DEFAULT_WAYS_OF_WORKING);
}

export function appendWaysOfWorking(session: string, content: string): string {
  const current = readWaysOfWorking(session, 0) || "";
  return writeWaysOfWorking(session, current + (current ? "\n\n" : "") + content);
}

export function clearWaysOfWorking(session: string): string {
  return writeWaysOfWorking(session, "");
}
