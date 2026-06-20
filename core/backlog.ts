/**
 * amux — Task Backlog
 *
 * Lightweight ordered work queue for multi-agent projects.
 * Array order = priority (first item = highest priority).
 * Auto-incrementing IDs: TASK-01, TASK-02, etc.
 *
 * File per session:
 *   backlog.json — Task[] (ordered array)
 */

import {
  sessionFile,
  readJson,
  atomicWriteJson,
  withJsonFile,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

export interface Task {
  id: string; // "TASK-01" auto-incrementing
  title: string;
  description?: string;
  status: "todo" | "assigned" | "in-progress" | "done" | "blocked";
  assignee?: string; // agent display name
  assigneeId?: string; // agent UUID
  dependsOn?: string[]; // task IDs that must be done before this task can be picked
  files?: string[]; // related files (auto-reserve on pick)
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string; // completion notes
  blockedReason?: string;
}

export type Backlog = Task[];

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

/**
 * Generate the next task ID based on existing tasks.
 * Scans for the highest TASK-XX number and increments.
 */
export function nextTaskId(tasks: Task[]): string {
  let maxNum = 0;
  for (const task of tasks) {
    const match = task.id.match(/^TASK-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `TASK-${String(maxNum + 1).padStart(2, "0")}`;
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
    const id = nextTaskId(tasks);
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
