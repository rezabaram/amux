/**
 * amux — Task Workflow Service
 *
 * Framework-agnostic business logic for task operations.
 * Handles validation, state mutation, file reservations, and activity recording.
 * Returns structured results for adapters to format and deliver.
 *
 * Pi adapter (or CLI, or any framework) calls these and handles only
 * framework-specific concerns (tool schemas, notifications, response format).
 */

import {
  type BacklogItem,
  readBacklog,
  writeBacklog,
  unmetDependencies,
  readSpecPreview,
} from "./backlog.ts";
import {
  assertTaskTransitionAllowed,
  assertTaskTransitionOwnership,
} from "./task-state-machine.ts";
import {
  reserve,
  release,
} from "./reservations.ts";
import {
  getOnlineAgents,
  findById,
  updateAgent,
  shouldSignalAgentForWork,
  type AgentInfo,
} from "./registry.ts";
import {
  appendTaskComment,
  readTaskComments,
  type TaskComment,
} from "./task-comments.ts";

// ─── Result Types ────────────────────────────────────────────

export interface AssignResult {
  assigned: BacklogItem[];
  /** Whether the target agent should receive an attention signal. */
  shouldSignal: boolean;
  targetId: string;
}

export interface PickResult {
  task: BacklogItem;
  reserved: string[];
  conflicts: Array<{ path: string; detail: string }>;
}

export interface CompleteResult {
  task: BacklogItem;
  released: string[];
  /** Whether the agent has no remaining in-progress tasks. */
  nowIdle: boolean;
}

export interface ReviewResult {
  task: BacklogItem;
  released: string[];
  /** Whether the implementer has no remaining in-progress tasks. */
  nowIdle: boolean;
}

export interface DropResult {
  task: BacklogItem;
  released: string[];
  nowIdle: boolean;
}

export interface BlockResult {
  task: BacklogItem;
}

export interface TaskShowData {
  task: BacklogItem;
  allTasks: BacklogItem[];
  comments: TaskComment[];
  specPreview: string | null;
}

// ─── Assign ──────────────────────────────────────────────────

/**
 * Assign one or more tasks to an agent.
 * Validates all tasks before assigning any (all-or-nothing).
 */
export async function serviceAssignTasks(
  session: string,
  taskIds: string[],
  targetId: string,
  targetName: string,
  assignerId: string,
  assignerName: string,
): Promise<AssignResult> {
  const tasks = await readBacklog(session);
  const toAssign: BacklogItem[] = [];

  for (const taskId of taskIds) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    assertTaskTransitionAllowed(task, "assign");
    toAssign.push(task);
  }

  const now = new Date().toISOString();
  for (const task of toAssign) {
    task.status = "assigned";
    task.assignee = targetName;
    task.assigneeId = targetId;
    task.updatedAt = now;
  }
  await writeBacklog(session, tasks);

  // Record activity
  for (const task of toAssign) {
    appendTaskComment(session, task.id, {
      timestamp: now,
      agent: assignerName,
      agentId: assignerId,
      type: "activity",
      text: `Assigned to ${targetName} by ${assignerName}`,
    });
  }

  // Check attention signal. Stale `working` availability should not suppress
  // assigned-work nudges when the target has no active in-progress item.
  const targetAgent = await findById(session, targetId);
  const targetHasActiveWork = tasks.some((t) =>
    t.status === "in-progress" && t.assigneeId === targetId
  );
  const shouldSignal = targetAgent
    ? shouldSignalAgentForWork(targetAgent, targetHasActiveWork)
    : false;
  if (shouldSignal) {
    await updateAgent(session, targetId, { attentionPending: true });
  }

  return { assigned: toAssign, shouldSignal, targetId };
}

// ─── Pick ────────────────────────────────────────────────────

/**
 * Pick a task (by ID or auto-pick).
 * Auto-pick prefers assigned-to-self items with met dependencies.
 */
export async function servicePickTask(
  session: string,
  taskId: string | undefined,
  agentId: string,
  agentName: string,
): Promise<PickResult> {
  const tasks = await readBacklog(session);
  let task: BacklogItem | undefined;

  if (taskId) {
    task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);

    assertTaskTransitionAllowed(task, "pick");
    assertTaskTransitionOwnership(task, "pick", agentId);

    const unmet = unmetDependencies(task, tasks);
    if (unmet.length > 0) {
      throw new Error(`${taskId} has unfinished dependencies: ${unmet.join(", ")}. Complete those tasks first.`);
    }
  } else {
    // Auto-pick: prefer assigned-to-self with met deps, then open todo
    task = tasks.find((t) => t.status === "assigned" && t.assigneeId === agentId && unmetDependencies(t, tasks).length === 0)
      || tasks.find((t) => t.status === "todo" && unmetDependencies(t, tasks).length === 0);
    if (!task) {
      throw new Error("No tasks available to pick. All tasks are assigned, in progress, blocked, done, or waiting on dependencies.");
    }
  }

  // Claim the task
  task.status = "in-progress";
  task.assignee = agentName;
  task.assigneeId = agentId;
  task.blockedReason = undefined;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTaskComment(session, task.id, {
    timestamp: task.updatedAt,
    agent: agentName,
    agentId,
    type: "activity",
    text: `Picked by ${agentName}`,
  });

  // Auto-set availability to working
  await updateAgent(session, agentId, {
    availability: "working",
    availabilityUpdatedAt: new Date().toISOString(),
  });

  // Auto-reserve files
  const reserved: string[] = [];
  const conflicts: Array<{ path: string; detail: string }> = [];

  if (task.files?.length) {
    const online = await getOnlineAgents(session).catch(() => [] as AgentInfo[]);
    const onlineIds = online.map((a) => a.id);
    const reserveReason = `${task.id}: ${task.title}`;

    for (const filePath of task.files) {
      try {
        await reserve(session, [filePath], agentId, agentName, reserveReason, onlineIds);
        reserved.push(filePath);
      } catch (err) {
        conflicts.push({ path: filePath, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { task, reserved, conflicts };
}

// ─── Done ────────────────────────────────────────────────────

/**
 * Complete a task. Releases file reservations and checks for idle.
 */
export async function serviceCompleteTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  summary?: string,
): Promise<CompleteResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  assertTaskTransitionAllowed(task, "done");
  assertTaskTransitionOwnership(task, "done", agentId);

  task.status = "done";
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  if (summary) task.summary = summary;
  await writeBacklog(session, tasks);

  appendTaskComment(session, task.id, {
    timestamp: task.updatedAt,
    agent: agentName,
    agentId,
    type: "activity",
    text: `Completed${summary ? `: ${summary}` : ""}`,
  });

  // Auto-release file reservations
  let released: string[] = [];
  if (task.files?.length) {
    released = await release(session, task.files, agentId);
  }

  // Check if agent should transition to idle
  const remainingActive = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === agentId);
  let nowIdle = false;
  if (remainingActive.length === 0) {
    const agent = await findById(session, agentId);
    if (!agent?.availability || agent.availability === "working") {
      await updateAgent(session, agentId, { availability: "idle", availabilityUpdatedAt: new Date().toISOString() });
      nowIdle = true;
    }
  }

  return { task, released, nowIdle };
}

// ─── Review ──────────────────────────────────────────────────

/**
 * Mark implementation ready for review. Releases file reservations and checks for idle.
 */
export async function serviceReviewTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  summary?: string,
): Promise<ReviewResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  assertTaskTransitionAllowed(task, "review");
  assertTaskTransitionOwnership(task, "review", agentId);

  task.status = "review";
  task.updatedAt = new Date().toISOString();
  if (summary) task.summary = summary;
  await writeBacklog(session, tasks);

  appendTaskComment(session, task.id, {
    timestamp: task.updatedAt,
    agent: agentName,
    agentId,
    type: "activity",
    text: `Ready for review${summary ? `: ${summary}` : ""}`,
  });

  let released: string[] = [];
  if (task.files?.length) {
    released = await release(session, task.files, agentId);
  }

  const remainingActive = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === agentId);
  let nowIdle = false;
  if (remainingActive.length === 0) {
    const agent = await findById(session, agentId);
    if (!agent?.availability || agent.availability === "working") {
      await updateAgent(session, agentId, { availability: "idle", availabilityUpdatedAt: new Date().toISOString() });
      nowIdle = true;
    }
  }

  return { task, released, nowIdle };
}

// ─── Drop ────────────────────────────────────────────────────

/**
 * Drop a task back to the queue. Releases file reservations.
 */
export async function serviceDropTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
): Promise<DropResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  assertTaskTransitionAllowed(task, "drop");
  assertTaskTransitionOwnership(task, "drop", agentId);

  task.status = "todo";
  task.assignee = undefined;
  task.assigneeId = undefined;
  task.blockedReason = undefined;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTaskComment(session, task.id, {
    timestamp: task.updatedAt,
    agent: agentName,
    agentId,
    type: "activity",
    text: `Dropped \u2014 back in queue`,
  });

  let released: string[] = [];
  if (task.files?.length) {
    released = await release(session, task.files, agentId);
  }

  const remainingActive = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === agentId);
  let nowIdle = false;
  if (remainingActive.length === 0) {
    const agent = await findById(session, agentId);
    if (!agent?.availability || agent.availability === "working") {
      await updateAgent(session, agentId, { availability: "idle", availabilityUpdatedAt: new Date().toISOString() });
      nowIdle = true;
    }
  }

  return { task, released, nowIdle };
}

// ─── Block ───────────────────────────────────────────────────

/**
 * Block a task with a reason.
 */
export async function serviceBlockTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  reason: string,
): Promise<BlockResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  assertTaskTransitionAllowed(task, "block");
  assertTaskTransitionOwnership(task, "block", agentId);

  task.status = "blocked";
  task.blockedReason = reason;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTaskComment(session, task.id, {
    timestamp: task.updatedAt,
    agent: agentName,
    agentId,
    type: "activity",
    text: `Blocked: ${reason}`,
  });

  return { task };
}

// ─── Show Data Assembly ──────────────────────────────────────

/**
 * Assemble all data needed to render task details.
 * Adapter calls this, then passes result to renderTaskDetails.
 */
export async function serviceGetTaskShowData(
  session: string,
  taskId: string,
): Promise<TaskShowData> {
  const allTasks = await readBacklog(session);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  const comments = readTaskComments(session, taskId);
  const specPreview = task.specPath ? readSpecPreview(session, task.specPath, 1024) : null;

  return { task, allTasks, comments, specPreview };
}
