/**
 * amux — Backlog
 *
 * Lightweight ordered work queue for multi-agent projects.
 * Each entry is a BacklogItem with type-prefixed IDs (TASK-*, INIT-*, BUG-*, etc.).
 * Array order = priority (first item = highest priority).
 *
 * File per session:
 *   backlog.json — BacklogItem[] (ordered array)
 */

import {
  sessionFile,
  readJson,
  atomicWriteJson,
  withJsonFile,
} from "./storage.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────

export interface BacklogItem {
  id: string; // e.g. "TASK-01", "INIT-01", "BUG-01"
  title: string;
  description?: string;
  itemType?: "task" | "initiative" | "milestone" | "bug" | "chore" | "spec";
  status: "todo" | "assigned" | "in-progress" | "review" | "done" | "blocked";
  assignee?: string; // agent display name
  assigneeId?: string; // agent UUID
  dependsOn?: string[]; // task IDs that must be done before this item can be picked
  files?: string[]; // related files (auto-reserve on pick)
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string; // completion notes
  blockedReason?: string;
  parentId?: string; // parent item ID for hierarchy
  order?: number; // sort order within siblings
  specPath?: string; // relative path to spec/plan file under artifacts/project/
}

/** @deprecated Use BacklogItem. Preserved for backward compatibility. */
export type Task = BacklogItem;

export type Backlog = BacklogItem[];

// ─── Paths ───────────────────────────────────────────────────

function backlogPath(session: string): string {
  return sessionFile(session, "backlog.json");
}

// ─── Backlog Operations ─────────────────────────────────────

/** Read the full task backlog for a session. */
export async function readBacklog(session: string): Promise<Backlog> {
  return readJson<Backlog>(backlogPath(session), []);
}

/** Write the full task backlog for a session (atomic). */
export async function writeBacklog(session: string, tasks: Backlog): Promise<void> {
  await atomicWriteJson(backlogPath(session), tasks);
}

/** ID prefix per item type. */
export const ITEM_TYPE_PREFIX: Record<string, string> = {
  task: "TASK",
  initiative: "INIT",
  milestone: "MS",
  bug: "BUG",
  chore: "CHORE",
  spec: "SPEC",
};

/**
 * Generate the next item ID based on existing items and item type.
 * Each prefix has its own sequence: TASK-01, BUG-01, INIT-01, etc.
 */
export function nextTaskId(tasks: Task[], itemType?: string): string {
  const prefix = ITEM_TYPE_PREFIX[itemType || "task"] || "TASK";
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let maxNum = 0;
  for (const task of tasks) {
    const match = task.id.match(pattern);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `${prefix}-${String(maxNum + 1).padStart(2, "0")}`;
}

/**
 * Add a new task to the backlog.
 * Appends by default, prepends if urgent.
 * Coordinated to prevent lost updates under concurrent writes.
 */
export async function addTask(
  session: string,
  taskData: Omit<Task, "id">,
  urgent?: boolean
): Promise<Task> {
  let task!: Task;
  await withJsonFile<Backlog>(backlogPath(session), [], (tasks) => {
    const id = nextTaskId(tasks, taskData.itemType);
    task = { id, ...taskData };
    if (urgent) {
      tasks.unshift(task);
    } else {
      tasks.push(task);
    }
    return tasks;
  });
  return task;
}

/** Find a task by ID. */
export async function getTask(session: string, id: string): Promise<Task | null> {
  const tasks = await readBacklog(session);
  return tasks.find((t) => t.id === id) ?? null;
}

/**
 * Check whether all of a task's dependencies are satisfied (status "done").
 * Returns the list of unmet dependency IDs, or an empty array if all met.
 * Tasks without dependencies always return [].
 */
export function unmetDependencies(task: Task, allTasks: Task[]): string[] {
  if (!task.dependsOn?.length) return [];
  return task.dependsOn.filter((depId) => {
    const dep = allTasks.find((t) => t.id === depId);
    return !dep || dep.status !== "done";
  });
}

/**
 * Update a task by ID with partial fields.
 * Automatically sets updatedAt.
 * Coordinated to prevent lost updates under concurrent writes.
 */
export async function updateTask(
  session: string,
  id: string,
  updates: Partial<Task>
): Promise<Task | null> {
  let found: Task | null = null;
  await withJsonFile<Backlog>(backlogPath(session), [], (tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (task) {
      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      found = task;
    }
    return tasks;
  });
  return found;
}

// ─── Spec / Plan Helpers ──────────────────────────────────

const SPEC_MAX_PREVIEW = 2048;

/** Conventional relative path for a backlog item spec under artifacts/project/. */
export function specRelativePath(itemId: string): string {
  return `tasks/${itemId}.md`;
}

/** Resolve a spec relative path to a full session path. */
export function specFullPath(session: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.length === 0 ||
    segments.includes("..")
  ) {
    throw new Error(`Invalid spec path: ${relativePath}`);
  }
  return sessionFile(session, "artifacts", "project", ...segments);
}

/** Generate a default markdown spec template for a backlog item. */
export function defaultSpecTemplate(item: BacklogItem): string {
  const typeLabel = item.itemType && item.itemType !== "task" ? ` (${item.itemType})` : "";
  return [
    `# ${item.id}: ${item.title}${typeLabel}`,
    "",
    "## Objective",
    "",
    "## Approach",
    "",
    "## Acceptance Criteria",
    "",
    "## Notes",
    "",
  ].join("\n");
}

/**
 * Read a spec file preview with a size guard.
 * Returns null if the file doesn’t exist or is empty.
 */
export function readSpecPreview(
  session: string,
  relativePath: string,
  maxChars: number = SPEC_MAX_PREVIEW,
): string | null {
  let path: string;
  try {
    path = specFullPath(session, relativePath);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    let content = readFileSync(path, "utf8").trim();
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[truncated]";
    }
    return content || null;
  } catch {
    return null;
  }
}

export interface PlanTaskSpecResult {
  specPath: string;
  fullPath: string;
  created: boolean;
  updated: boolean;
  linked: boolean;
  preview: string | null;
}

/**
 * Create, update, or link a first-class task spec.
 *
 * If content is provided, writes it. If content is omitted and the spec already
 * exists, preserves the existing file. If no spec exists, creates the default
 * template. Links item.specPath in the backlog when missing.
 */
export async function planTaskSpec(
  session: string,
  item: BacklogItem,
  content?: string,
): Promise<PlanTaskSpecResult> {
  const linked = !item.specPath;
  const specPath = item.specPath || specRelativePath(item.id);
  const fullPath = specFullPath(session, specPath);
  const existed = existsSync(fullPath);

  mkdirSync(dirname(fullPath), { recursive: true });

  let wrote = false;
  if (content !== undefined) {
    writeFileSync(fullPath, content, "utf8");
    wrote = true;
  } else if (!existed) {
    writeFileSync(fullPath, defaultSpecTemplate(item), "utf8");
    wrote = true;
  }

  if (linked) {
    await updateTask(session, item.id, { specPath });
  }

  return {
    specPath,
    fullPath,
    created: !existed,
    updated: wrote && existed,
    linked,
    preview: readSpecPreview(session, specPath, 500),
  };
}
