/**
 * amux — Task-Scoped Comments and Activity
 *
 * Append-only JSONL history per task, stored under `task-comments/<TASK-ID>.jsonl`.
 * Used for task-related discussion (like PR comments) and lifecycle activity.
 * Keeps discussion off the inbox and out of backlog.json.
 *
 * Pi-independent — no framework or adapter dependencies.
 */

import {
  sessionFile,
  readJsonlSync,
  appendJsonlSync,
} from "./storage.ts";
import type { BacklogItem } from "./backlog.ts";
import type { AgentInfo } from "./registry.ts";

// ─── Types ───────────────────────────────────────────────────

export interface TaskComment {
  id?: string; // optional stable ID for notification/linking
  timestamp: string; // ISO 8601
  agent: string; // display name of author
  agentId: string; // UUID of author
  type: "comment" | "activity"; // comment = discussion, activity = lifecycle event
  text: string;
}

// ─── Paths ───────────────────────────────────────────────────

function commentsPath(session: string, taskId: string): string {
  return sessionFile(session, "task-comments", `${taskId}.jsonl`);
}

// ─── Operations ──────────────────────────────────────────────

/**
 * Append a comment or activity record to a task's history.
 * Creates the task-comments directory and JSONL file on first write.
 */
export function appendTaskComment(
  session: string,
  taskId: string,
  entry: TaskComment,
): void {
  appendJsonlSync(commentsPath(session, taskId), entry);
}

/**
 * Read all comments/activity for a task in chronological order.
 * Returns [] if no comments exist yet.
 */
export function readTaskComments(
  session: string,
  taskId: string,
): TaskComment[] {
  return readJsonlSync<TaskComment>(commentsPath(session, taskId));
}

/**
 * Format a comment for display.
 * Returns a single line like:
 *   [2026-06-20 14:00] Alice (comment): Looks good, one suggestion on error handling.
 *   [2026-06-20 14:05] system (activity): Assigned to Bob by Alice
 */
export function formatTaskComment(entry: TaskComment): string {
  const date = entry.timestamp.slice(0, 16).replace("T", " ");
  return `[${date}] ${entry.agent} (${entry.type}): ${entry.text}`;
}

/** Return a compact one-line preview suitable for inbox notifications. */
export function taskCommentPreview(text: string, maxLength = 160): string {
  const compact = text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

/** Extract explicit @AgentName-style mentions from comment text. */
export function taskCommentMentions(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/(^|\s)@([A-Za-z0-9_-]+)/g)) {
    const name = match[2]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Resolve default recipients for a task comment notification.
 * Includes assignee, task creator, previous commenters, and explicit mentions;
 * excludes the comment author and de-duplicates by agent ID.
 */
export function resolveTaskCommentSubscribers(
  task: BacklogItem,
  previousComments: TaskComment[],
  agents: AgentInfo[],
  authorId: string,
  commentText: string,
): AgentInfo[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const selected = new Map<string, AgentInfo>();

  const add = (agent: AgentInfo | undefined): void => {
    if (!agent || agent.id === authorId) return;
    selected.set(agent.id, agent);
  };

  add(task.assigneeId ? byId.get(task.assigneeId) : undefined);
  add(task.createdBy ? byName.get(task.createdBy.toLowerCase()) : undefined);

  for (const comment of previousComments) {
    if (comment.type === "comment") add(byId.get(comment.agentId));
  }

  for (const name of taskCommentMentions(commentText)) {
    add(byName.get(name.toLowerCase()));
  }

  return [...selected.values()];
}
