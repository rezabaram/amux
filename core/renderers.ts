/**
 * amux — Task and Progress Renderers
 *
 * Pure presentation functions for formatting backlog items, task details,
 * and progress summaries. Framework-agnostic — no I/O, no Pi dependencies.
 * The Pi adapter pre-fetches data and calls these for consistent output.
 */

import type { BacklogItem } from "./backlog.ts";
import type { TaskComment } from "./task-comments.ts";
import { unmetDependencies } from "./backlog.ts";
import { formatTaskComment } from "./task-comments.ts";

// ─── Utilities ───────────────────────────────────────────────

/** Format a duration in milliseconds to a compact human-readable string. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

// ─── Status Markers ──────────────────────────────────────────

function statusMarker(status: string): string {
  switch (status) {
    case "done": return "\u2713";
    case "in-progress": return "\u25b6";
    case "blocked": return "\u26a0";
    case "assigned": return "\u2192";
    default: return "\u25cb";
  }
}

function typeLabel(item: BacklogItem): string {
  return item.itemType && item.itemType !== "task" ? ` (${item.itemType})` : "";
}

// ─── Task List Row ───────────────────────────────────────────

/**
 * Render a single backlog item as a compact list row.
 * Used by `amux_task list`.
 */
export function renderTaskListRow(
  task: BacklogItem,
  allTasks: BacklogItem[],
  position: number,
  currentAgentId?: string,
): string {
  const assigneeStr = task.assignee
    ? task.status === "assigned"
      ? ` \u2192 ${task.assignee} (pending)`
      : `  -- ${task.assignee}`
    : "";
  const isMe = currentAgentId && task.assigneeId === currentAgentId;
  const meMarker = isMe ? " (you)" : "";
  const filesStr = task.files?.length
    ? `\n                              Files: ${task.files.join(", ")}` : "";
  const depsStr = task.dependsOn?.length
    ? (() => {
        const unmet = unmetDependencies(task, allTasks);
        const label = task.dependsOn.join(", ");
        return `\n                              Depends on: ${label}${unmet.length > 0 ? " (waiting)" : " \u2713"}`;
      })()
    : "";
  const blockedStr = task.status === "blocked" && task.blockedReason
    ? `\n                              Blocked: ${task.blockedReason}` : "";
  const summaryStr = task.status === "done" && task.summary
    ? `\n                              Summary: ${task.summary}` : "";
  const doneTime = task.status === "done" && task.completedAt
    ? ` (${formatDuration(Date.now() - new Date(task.completedAt).getTime())} ago)` : "";
  const tLabel = task.itemType && task.itemType !== "task" ? `(${task.itemType}) ` : "";
  const specMarker = task.specPath ? " [spec]" : "";

  return `  #${String(position).padStart(2)}  ${task.id}  ${tLabel}[${task.status}]  ${task.title}${specMarker}${assigneeStr}${meMarker}${doneTime}${filesStr}${depsStr}${blockedStr}${summaryStr}`;
}

// ─── Task Details ────────────────────────────────────────────

export interface RenderTaskOptions {
  currentAgentId?: string;
  comments?: TaskComment[];
  specPreview?: string | null;
}

/**
 * Render full task details with metadata, spec preview, and comments.
 * Used by `amux_task show`.
 */
export function renderTaskDetails(
  task: BacklogItem,
  allTasks: BacklogItem[],
  options: RenderTaskOptions = {},
): string {
  let text = `${task.id}: ${task.title}  [${task.status}]`;
  if (task.description) text += `\n\n${task.description}`;
  text += `\n\nStatus: ${task.status}`;
  if (task.itemType && task.itemType !== "task") text += `\nType: ${task.itemType}`;
  if (task.parentId) {
    const parent = allTasks.find((t) => t.id === task.parentId);
    text += `\nParent: ${task.parentId}${parent ? `: ${parent.title}` : ""}`;
  }
  if (task.order != null) text += `\nOrder: ${task.order}`;
  if (task.assignee) {
    const youMarker = options.currentAgentId && task.assigneeId === options.currentAgentId ? " (you)" : "";
    text += `\nAssignee: ${task.assignee}${youMarker}`;
  }
  if (task.dependsOn?.length) {
    const unmet = unmetDependencies(task, allTasks);
    text += `\nDepends on: ${task.dependsOn.join(", ")}${unmet.length > 0 ? ` (waiting: ${unmet.join(", ")})` : " \u2713"}`;
  }
  if (task.files?.length) text += `\nFiles: ${task.files.join(", ")}`;
  if (task.blockedReason) text += `\nBlocked: ${task.blockedReason}`;
  if (task.summary) text += `\nSummary: ${task.summary}`;
  text += `\nCreated: ${task.createdAt} by ${task.createdBy}`;
  if (task.completedAt) text += `\nCompleted: ${task.completedAt}`;

  // Spec preview
  if (task.specPath) {
    text += `\nSpec: ${task.specPath}`;
    if (options.specPreview) text += `\n\n${options.specPreview}`;
  }

  // Comments
  const comments = options.comments || [];
  if (comments.length > 0) {
    text += `\n\n\u2500\u2500 Comments (${comments.length}) \u2500\u2500`;
    for (const c of comments) {
      text += `\n${formatTaskComment(c)}`;
    }
  } else {
    text += `\n\nNo comments yet. Use amux_task with action "comment" to add one.`;
  }

  return text;
}

// ─── Progress Summary ────────────────────────────────────────

/**
 * Render a compact hierarchical progress summary.
 * Used by `amux_task summary` and `/amux progress`.
 */
export function renderProgressSummary(
  session: string,
  tasks: BacklogItem[],
): string {
  if (tasks.length === 0) return `Project: ${session}\n\nNo backlog items yet.`;

  // Status counts
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  const total = tasks.length;
  const statusLine = ["todo", "assigned", "in-progress", "blocked", "done"]
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(" \u00b7 ");

  // Build children lookup, sorted by order then backlog position
  const childrenOf = new Map<string, BacklogItem[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const siblings = childrenOf.get(t.parentId) || [];
      siblings.push(t);
      childrenOf.set(t.parentId, siblings);
    }
  }
  for (const [, children] of childrenOf) {
    children.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  }

  let out = `Project: ${session}\n`;
  out += `${"\u2500".repeat(40)}\n`;
  out += `${statusLine}  (${total} total)\n`;

  // Render top-level items (those without parentId)
  const topLevel = tasks.filter((t) => !t.parentId);
  const hasHierarchy = childrenOf.size > 0;

  if (hasHierarchy) out += "\n";

  const assigneeStr = (t: BacklogItem) =>
    (t.status === "in-progress" || t.status === "assigned") && t.assignee ? ` \u2014 ${t.assignee}` : "";
  const blockedStr = (t: BacklogItem) =>
    t.status === "blocked" && t.blockedReason ? `: ${t.blockedReason}` : "";

  for (const t of topLevel) {
    const children = childrenOf.get(t.id);
    if (children && children.length > 0) {
      // Parent with indented children
      const childDone = children.filter((c) => c.status === "done").length;
      out += `\u25b8 ${t.id}${typeLabel(t)}  ${t.title} [${childDone}/${children.length}]\n`;
      for (const c of children) {
        out += `    ${statusMarker(c.status)} ${c.id}  ${c.title}${assigneeStr(c)}${blockedStr(c)}\n`;
      }
    } else {
      // Standalone item
      out += `${statusMarker(t.status)} ${t.id}${typeLabel(t)}  ${t.title}${assigneeStr(t)}${blockedStr(t)}\n`;
    }
  }

  // Recently done (last 3)
  const done = tasks
    .filter((t) => t.status === "done" && t.completedAt)
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
    .slice(0, 3);
  if (done.length > 0) {
    out += `\n\u2713 Recently Done:\n`;
    for (const t of done) {
      const ago = t.completedAt
        ? formatDuration(Date.now() - new Date(t.completedAt).getTime()) + " ago"
        : "";
      out += `  ${t.id}  ${t.title}${ago ? ` (${ago})` : ""}\n`;
    }
  }

  return out.trimEnd();
}
