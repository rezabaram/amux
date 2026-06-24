/**
 * amux — Task State Machine (pure)
 *
 * Declares task lifecycle transition rules, ownership validation, and
 * notification intent as explicit data. Pure module — no I/O, no side
 * effects, no filesystem access. All functions are synchronous.
 *
 * SPEC-19 Slice 1: the six existing lifecycle service functions in
 * `task-service.ts` delegate their pre-flight status/ownership checks
 * to this module. Behavior is preserved — error messages, mutation,
 * reservations, activity entries, and notifications are unchanged.
 *
 * Later slices will add a transition executor that derives activity text,
 * side-effect descriptors, and notification plans from the same table.
 */

import type { BacklogItem } from "./backlog.ts";

// ─── Types ───────────────────────────────────────────────────

export type TaskState = "todo" | "assigned" | "in-progress" | "review" | "done" | "blocked";

export type TaskTransitionAction =
  | "assign"
  | "pick"
  | "review"
  | "done"
  | "drop"
  | "block"
  | "comment"
  | "plan"
  | "archive";

export type NotifyTarget =
  | { mode: "none" }
  | { mode: "subscribers" }
  | { mode: "all" }
  | { mode: "agents"; agents: string[] };

/** Who is allowed to perform a transition. */
export type OwnershipMode = "none" | "assignee" | "assignee-or-reviewer";

export interface TransitionActor {
  id: string;
  name: string;
  roleName?: string;
  session: string;
}

/**
 * One row in the transition table. When `from` is an array, the definition
 * applies to any of those states. Multiple definitions per action exist when
 * ownership or target varies by source state (e.g. `done` from `in-progress`
 * requires the assignee, but from `review` any reviewer can complete).
 */
export interface TaskTransitionDefinition {
  action: TaskTransitionAction;
  from: TaskState[] | "same";
  to: TaskState | "same" | "archive";
  defaultNotify: NotifyTarget;
  ownership: OwnershipMode;
}

// ─── Transition table ────────────────────────────────────────
//
// Behavior-preserving: every row codifies what `task-service.ts` already
// enforces via inline guards. Notification intent is declared for future
// slices but not consumed in slice 1.

const TRANSITIONS: TaskTransitionDefinition[] = [
  // assign — any agent can (re)assign; target gets nudged
  {
    action: "assign",
    from: ["todo", "assigned", "blocked"],
    to: "assigned",
    ownership: "none",
    defaultNotify: { mode: "agents", agents: [] }, // resolved to assignee at runtime
  },
  // pick — claiming work; assigned tasks require the assignee. Review-state
  // tasks can be picked by any reviewer/agent for changes (existing behavior).
  {
    action: "pick",
    from: ["todo", "blocked", "review"],
    to: "in-progress",
    ownership: "none",
    defaultNotify: { mode: "none" },
  },
  {
    action: "pick",
    from: ["assigned"],
    to: "in-progress",
    ownership: "assignee",
    defaultNotify: { mode: "none" },
  },
  // review — only the implementer (assignee) can mark ready
  {
    action: "review",
    from: ["in-progress"],
    to: "review",
    ownership: "assignee",
    defaultNotify: { mode: "none" },
  },
  // done — existing simple workflows allow direct completion from any
  // non-done state. Assignee-gated states require the assignee; review allows
  // any reviewer/non-assignee to complete after integration.
  {
    action: "done",
    from: ["todo", "assigned", "in-progress", "blocked"],
    to: "done",
    ownership: "assignee",
    defaultNotify: { mode: "none" },
  },
  {
    action: "done",
    from: ["review"],
    to: "done",
    ownership: "assignee-or-reviewer",
    defaultNotify: { mode: "none" },
  },
  // drop — assignee releases back to queue
  {
    action: "drop",
    from: ["assigned", "in-progress", "review", "blocked"],
    to: "todo",
    ownership: "assignee",
    defaultNotify: { mode: "none" },
  },
  // block — assignee (if assigned) marks or updates blocked state
  {
    action: "block",
    from: ["todo", "assigned", "in-progress", "review", "blocked"],
    to: "blocked",
    ownership: "assignee",
    defaultNotify: { mode: "none" },
  },
  // non-status transitions — no lifecycle state change
  {
    action: "comment",
    from: "same",
    to: "same",
    ownership: "none",
    defaultNotify: { mode: "subscribers" },
  },
  {
    action: "plan",
    from: "same",
    to: "same",
    ownership: "none",
    defaultNotify: { mode: "none" },
  },
  {
    action: "archive",
    from: ["done"],
    to: "archive",
    ownership: "none",
    defaultNotify: { mode: "none" },
  },
];

// ─── Lookup ──────────────────────────────────────────────────

/**
 * Find the transition definition for an action from a given state.
 * Returns `null` if the transition is not defined (disallowed).
 */
export function getTaskTransitionDefinition(
  action: TaskTransitionAction,
  from: TaskState,
): TaskTransitionDefinition | null {
  return (
    TRANSITIONS.find(
      (t) =>
        t.action === action &&
        (t.from === "same" || t.from.includes(from)),
    ) ?? null
  );
}

/** Whether the action can be performed from the given state. */
export function canTransition(from: TaskState, action: TaskTransitionAction): boolean {
  return getTaskTransitionDefinition(action, from) !== null;
}

/** The resulting status after the transition, or `"same"` / `"archive"`. */
export function targetStatus(
  from: TaskState,
  action: TaskTransitionAction,
): TaskState | "same" | "archive" {
  return getTaskTransitionDefinition(action, from)?.to ?? "same";
}

// ─── Error messages ──────────────────────────────────────────
//
// Preserved verbatim from the original inline guards in task-service.ts
// so delegation does not change any error text that users or tests rely on.

function statusErrorMessage(task: BacklogItem, action: TaskTransitionAction): string {
  const id = task.id;
  const status = task.status;
  const assignee = task.assignee ?? "someone";

  switch (action) {
    case "assign":
      if (status === "in-progress")
        return `${id} is actively being worked on by ${assignee}. Ask them to drop it first.`;
      if (status === "review")
        return `${id} is ready for review. Complete or pick it for changes instead.`;
      if (status === "done") return `${id} is already done.`;
      break;
    case "pick":
      if (status === "in-progress")
        return `${id} is already in progress${task.assignee ? ` by ${task.assignee}` : ""}.`;
      if (status === "done") return `${id} is already done.`;
      break;
    case "review":
      if (status === "done") return `${id} is already done.`;
      if (status === "review") return `${id} is already ready for review.`;
      return `${id} must be in progress before it can be marked ready for review.`;
    case "done":
      if (status === "done") return `${id} is already done.`;
      break;
    case "drop":
      if (status === "done") return `${id} is already done.`;
      if (status === "todo") return `${id} is not assigned to anyone.`;
      break;
    case "block":
      if (status === "done") return `${id} is already done.`;
      break;
  }
  // Fallback for states tightened by the table (latent gaps in the old code)
  return `${id} cannot be ${action}ed from status "${status}".`;
}

const OWNERSHIP_VERBS: Partial<Record<TaskTransitionAction, string>> = {
  review: "mark it ready for review",
  done: "mark it done",
  drop: "drop it",
  block: "block it",
};

function ownershipErrorMessage(task: BacklogItem, action: TaskTransitionAction): string {
  const assignee = task.assignee ?? "someone";
  if (action === "pick") {
    return `${task.id} is assigned to ${assignee}, waiting for their response.`;
  }
  const verb = OWNERSHIP_VERBS[action] ?? `${action} it`;
  return `${task.id} is assigned to ${assignee}. Only the assignee can ${verb}.`;
}

// ─── Assertions ──────────────────────────────────────────────

/**
 * Assert that the transition is allowed from the task's current status.
 * Throws with the same error messages the original inline guards produced.
 */
export function assertTaskTransitionAllowed(
  task: BacklogItem,
  action: TaskTransitionAction,
): void {
  if (!canTransition(task.status as TaskState, action)) {
    throw new Error(statusErrorMessage(task, action));
  }
}

/**
 * Assert that the actor has ownership rights for the transition.
 * Throws with the same error messages the original inline guards produced.
 *
 * Must be called after `assertTaskTransitionAllowed` (relies on the
 * transition being defined for the current state).
 */
export function assertTaskTransitionOwnership(
  task: BacklogItem,
  action: TaskTransitionAction,
  actorId: string,
): void {
  const def = getTaskTransitionDefinition(action, task.status as TaskState);
  if (!def) return; // disallowed transition — handled by assertTaskTransitionAllowed

  switch (def.ownership) {
    case "none":
      return;
    case "assignee":
      if (task.assigneeId && task.assigneeId !== actorId) {
        throw new Error(ownershipErrorMessage(task, action));
      }
      return;
    case "assignee-or-reviewer":
      // From review state, any actor can complete (reviewer path).
      // The transition definition already constrains this to from "review".
      return;
  }
}
