/**
 * Neutral backlog management tool.
 *
 * Migrates the large `amux_task` tool out of the Pi adapter. This is the
 * highest-risk migration (13 actions, lifecycle ownership rules, reservation
 * side effects, notification delivery). All handler logic moved verbatim;
 * only identity access changed (Pi closures → AmuxToolContext fields).
 *
 * Behavior is preserved exactly — this slice does not redesign lifecycle
 * semantics (state-machine work is a separate follow-up).
 *
 * Structure (per Lead guidance: "small focused helpers, not one giant switch"):
 *   Each action is a standalone async helper. The tool's execute() is a
 *   clean dispatch switch that delegates to these helpers.
 */

import {
  type BacklogItem,
  getTask,
  addTask,
  readBacklog,
  planTaskSpec,
  archiveDoneTasks,
} from "../backlog.ts";
import {
  serviceGetTaskShowData,
  serviceAssignTasks,
  servicePickTask,
  serviceReviewTask,
  serviceCompleteTask,
  serviceDropTask,
  serviceBlockTask,
} from "../task-service.ts";
import {
  readTaskComments,
  appendTaskComment,
  type TaskComment,
} from "../task-comments.ts";
import { renderTaskListRow, renderTaskDetails, renderProgressSummary } from "../renderers.ts";
import { resolveAgent, parseAddress } from "../registry.ts";
import { newMessageId } from "../messaging.ts";
import {
  deliverNotificationPlans,
  planAssignmentNotification,
  notifyTaskCommentSubscribers,
  type NotificationSender,
} from "../notification-service.ts";
import {
  type AmuxToolContext,
  type AmuxToolDefinition,
  type AmuxToolResult,
  enumProp,
  objectSchema,
  optionalBoolProp,
  optionalStringProp,
  stringProp,
} from "./types.ts";

// ─── Params ──────────────────────────────────────────────────

const TASK_ACTIONS = [
  "add", "list", "show", "comment", "plan", "edit-plan",
  "assign", "pick", "review", "done", "drop", "block", "archive", "summary",
] as const;

const ITEM_TYPES = ["task", "initiative", "milestone", "bug", "chore", "spec"] as const;
const TASK_STATUSES = ["todo", "assigned", "in-progress", "review", "done", "blocked"] as const;

interface TaskParams {
  action: typeof TASK_ACTIONS[number];
  // add
  title?: string;
  description?: string;
  itemType?: typeof ITEM_TYPES[number];
  files?: string[];
  dependsOn?: string[];
  parentId?: string;
  order?: number;
  urgent?: boolean;
  // assign, pick, done, drop, block
  id?: string;
  to?: string;
  reason?: string;
  summary?: string;
  content?: string;
  notify?: boolean;
  silent?: boolean;
  // list
  status?: string;
}

/** Build the NotificationSender from the neutral tool context. */
function senderFromContext(ctx: AmuxToolContext): NotificationSender {
  return { id: ctx.agentId, name: ctx.agentName, roleName: ctx.roleName, session: ctx.session };
}

// ─── Action helpers ──────────────────────────────────────────

async function executeAdd(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.title) throw new Error("Title is required for add.");
  const now = new Date().toISOString();
  if (p.parentId) {
    const parent = await getTask(ctx.session, p.parentId);
    if (!parent) throw new Error(`Parent item ${p.parentId} not found.`);
  }
  const task = await addTask(ctx.session, {
    title: p.title,
    description: p.description,
    itemType: p.itemType as BacklogItem["itemType"],
    status: "todo",
    dependsOn: p.dependsOn,
    parentId: p.parentId,
    order: p.order,
    files: p.files,
    createdBy: ctx.agentName,
    createdAt: now,
    updatedAt: now,
  }, p.urgent);
  const urgentNote = p.urgent ? " (urgent  -- top of backlog)" : "";
  const typeNote = task.itemType && task.itemType !== "task" ? `\n  Type: ${task.itemType}` : "";
  const filesNote = task.files?.length ? `\n  Files: ${task.files.join(", ")}` : "";
  const depsNote = task.dependsOn?.length ? `\n  Depends on: ${task.dependsOn.join(", ")}` : "";
  return {
    text: `Created ${task.id}: ${task.title}${urgentNote}${typeNote}${depsNote}${filesNote}`,
    details: { task },
  };
}

async function executeList(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  const tasks = await readBacklog(ctx.session);
  let filtered = tasks;
  if (p.status) {
    filtered = filtered.filter((t) => t.status === p.status);
  }
  if (filtered.length === 0) {
    const filterNote = p.status ? ` with status "${p.status}"` : "";
    return { text: `No tasks found${filterNote}.`, details: { tasks: [] } };
  }
  const lines = filtered.map((t) => {
    const pos = tasks.indexOf(t) + 1;
    return renderTaskListRow(t, tasks, pos, ctx.agentId);
  });
  return {
    text: `Backlog (${filtered.length} task${filtered.length !== 1 ? "s" : ""}):\n\n${lines.join("\n")}`,
    details: { tasks: filtered },
  };
}

async function executeShow(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for show.");
  const data = await serviceGetTaskShowData(ctx.session, p.id);
  const text = renderTaskDetails(data.task, data.allTasks, {
    currentAgentId: ctx.agentId,
    comments: data.comments,
    specPreview: data.specPreview,
  });
  return { text, details: { task: data.task, comments: data.comments } };
}

async function executeComment(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for comment.");
  if (!p.content) throw new Error("Comment text is required (pass content parameter).");
  const task = await getTask(ctx.session, p.id);
  if (!task) throw new Error(`Task ${p.id} not found.`);
  const previousComments = readTaskComments(ctx.session, p.id);
  const comment: TaskComment = {
    id: newMessageId(),
    timestamp: new Date().toISOString(),
    agent: ctx.agentName,
    agentId: ctx.agentId,
    type: "comment",
    text: p.content,
  };
  appendTaskComment(ctx.session, p.id, comment);
  const shouldNotify = p.silent === true ? false : p.notify !== false;
  const notified = shouldNotify
    ? await notifyTaskCommentSubscribers(ctx.session, senderFromContext(ctx), task, previousComments, comment)
    : [];
  const notifyText = shouldNotify
    ? notified.length > 0 ? ` Notified: ${notified.join(", ")}.` : " No subscribers notified."
    : " Notifications skipped.";
  return {
    text: `Comment added to ${p.id}.${notifyText}`,
    details: { taskId: p.id, commentId: comment.id, notified },
  };
}

async function executePlan(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for plan.");
  const task = await getTask(ctx.session, p.id);
  if (!task) throw new Error(`Task ${p.id} not found.`);
  const result = await planTaskSpec(ctx.session, task, p.content);
  const verb = result.updated ? "updated" : result.created ? "created" : "ready";
  const linkNote = result.linked ? "\nLinked specPath on backlog item." : "";
  return {
    text: `Spec ${verb}: ${result.fullPath}${linkNote}\n\n${result.preview || "(empty)"}`,
    details: { taskId: p.id, specPath: result.specPath, fullPath: result.fullPath },
  };
}

async function executeEditPlan(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for edit-plan.");
  const task = await getTask(ctx.session, p.id);
  if (!task) throw new Error(`Task ${p.id} not found.`);
  const result = await planTaskSpec(ctx.session, task);
  return {
    text: `Spec path: ${result.fullPath}\n\nUse read/edit tools to modify the spec.`,
    details: { taskId: p.id, specPath: result.specPath, fullPath: result.fullPath },
  };
}

async function executeSummary(ctx: AmuxToolContext): Promise<AmuxToolResult> {
  const tasks = await readBacklog(ctx.session);
  const summary = renderProgressSummary(ctx.session, tasks);
  return { text: summary, details: {} };
}

async function executeArchive(ctx: AmuxToolContext): Promise<AmuxToolResult> {
  const result = await archiveDoneTasks(ctx.session);
  const archivedIds = result.archived.map((t) => t.id).join(", ") || "none";
  const skippedText = result.skipped.length > 0
    ? `\nSkipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.item.id} (${s.reason})`).join(", ")}`
    : "";
  return {
    text: `Archived ${result.archived.length} done item(s): ${archivedIds}.${skippedText}\nArchive: ${result.archivePath}`,
    details: result,
  };
}

async function executeAssign(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID(s) required for assign (comma-separated for batch).");
  if (!p.to) throw new Error("Target agent name is required for assign.");
  const { session: targetSession } = parseAddress(p.to, ctx.session);
  if (targetSession !== ctx.session) {
    throw new Error(
      `Cross-session task assignment is not supported. ` +
      `"${p.to}" resolves to session "${targetSession}", but tasks ` +
      `can only be assigned to agents within the current session ("${ctx.session}").`,
    );
  }
  const target = await resolveAgent(p.to, ctx.session);
  if (!target) throw new Error(`Agent "${p.to}" not found.`);
  const taskIds = p.id.split(",").map((s) => s.trim()).filter(Boolean);
  const result = await serviceAssignTasks(ctx.session, taskIds, target.id, target.name, ctx.agentId, ctx.agentName);
  // Deliver the core-planned assignment notification when service requests attention.
  if (result.shouldSignal) {
    await deliverNotificationPlans(
      [planAssignmentNotification(target, result.assigned.map((t) => ({ id: t.id, title: t.title })))],
      senderFromContext(ctx),
    );
  }
  const assignedIds = result.assigned.map((t) => t.id).join(", ");
  return {
    text: `Assigned ${assignedIds} to ${target.name}. Task state updated; visible via amux_task show.`,
    details: { tasks: result.assigned },
  };
}

async function executePick(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  const pickResult = await servicePickTask(ctx.session, p.id || undefined, ctx.agentId, ctx.agentName);
  let pickText = `\u2713 Picked ${pickResult.task.id}: ${pickResult.task.title}`;
  if (p.reason) pickText += `\n  Approach: ${p.reason}`;
  if (pickResult.reserved.length > 0) pickText += `\n  Reserved: ${pickResult.reserved.join(", ")}`;
  if (pickResult.conflicts.length > 0) {
    pickText += `\n  \u26a0\ufe0f Could not reserve: ${pickResult.conflicts.map((c) => `${c.path} (${c.detail})`).join("; ")}`;
  }
  return { text: pickText, details: pickResult };
}

async function executeReview(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for review.");
  const reviewResult = await serviceReviewTask(ctx.session, p.id, ctx.agentId, ctx.agentName, p.summary);
  let reviewText = `◇ Ready for review ${reviewResult.task.id}: ${reviewResult.task.title}`;
  if (p.summary) {
    reviewText += `\n  Handoff: ${p.summary}`;
  } else {
    reviewText += `\n  Tip: include commit/branch, diff summary, tests run, and known risks in summary for token-efficient review.`;
  }
  reviewText += `\n  Reviewer flow: read spec → inspect diff → inspect tests → comment or done.`;
  if (reviewResult.released.length > 0) reviewText += `\n  Released: ${reviewResult.released.join(", ")}`;
  return { text: reviewText, details: reviewResult };
}

async function executeDone(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for done.");
  const doneResult = await serviceCompleteTask(ctx.session, p.id, ctx.agentId, ctx.agentName, p.summary);
  let doneText = `\u2713 Completed ${doneResult.task.id}: ${doneResult.task.title}`;
  if (p.summary) doneText += `\n  Summary: ${p.summary}`;
  if (doneResult.released.length > 0) doneText += `\n  Released: ${doneResult.released.join(", ")}`;
  return { text: doneText, details: doneResult };
}

async function executeDrop(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for drop.");
  const dropResult = await serviceDropTask(ctx.session, p.id, ctx.agentId, ctx.agentName);
  let dropText = `\u2713 Dropped ${dropResult.task.id}: ${dropResult.task.title}  -- back in queue`;
  if (dropResult.released.length > 0) dropText += `\n  Released: ${dropResult.released.join(", ")}`;
  return { text: dropText, details: dropResult };
}

async function executeBlock(ctx: AmuxToolContext, p: TaskParams): Promise<AmuxToolResult> {
  if (!p.id) throw new Error("Task ID is required for block.");
  if (!p.reason) throw new Error("Reason is required for block.");
  const blockResult = await serviceBlockTask(ctx.session, p.id, ctx.agentId, ctx.agentName, p.reason);
  return { text: `\u26a0\ufe0f ${blockResult.task.id} blocked: ${p.reason}`, details: blockResult };
}

// ─── Tool definition ─────────────────────────────────────────

export const taskTool: AmuxToolDefinition<TaskParams> = {
  name: "amux_task",
  label: "Task Backlog",
  description:
    "Manage the task backlog. Actions: add (create task), list (show tasks), " +
    "show (task details + comments/spec preview), comment (add task-scoped comment), " +
    "plan/edit-plan (manage task-linked specs), " +
    "assign (delegate to same-session agent, comma-separated IDs for batch), pick (claim/accept task), " +
    "review (mark implementation ready for review), done (complete), drop (release back to queue), block (mark blocked), archive (archive completed items). " +
    "Tasks can declare dependencies via dependsOn. " +
    "Picking a task auto-reserves its files. Done/drop auto-releases them.",
  promptSnippet: "Manage task backlog  -- add, list, show, comment, plan, edit-plan, assign, pick, review, done, drop, block, archive",
  promptGuidelines: [
    "Use action 'pick' to claim the next available task or accept an assigned task.",
    "Picking a task auto-reserves its files. Done/drop auto-releases them.",
    "Use action 'review' when implementation is ready for review/integration, and include commit/branch, diff summary, tests run, and known risks in summary.",
    "Use action 'done' when reviewed/integrated/verified; reviewers should inspect spec + diff + tests before completing.",
    "Use action 'assign' to delegate executable leaf work items to same-session agents  -- the assignee accepts by picking",
    "Create and review high-level initiatives/milestones and their children before assigning executable child work.",
    "It is OK to assign all defined leaf work up front; use dependsOn to enforce order, and assignees should pick one item at a time after completing the current item.",
    "When working on a child item, inspect its parent context with amux_task show before picking or implementing.",
    "Use dependsOn when adding an item that should wait for other items to complete.",
    "Pass comma-separated IDs to assign multiple items in one state update.",
    "Only the assignee can review/drop/block an assigned item; review items can be completed by a reviewer.",
    "Use 'show' to view item details, parent context, linked spec preview, and comment history.",
    "Use 'plan' and 'edit-plan' for first-class task-linked specs/checklists instead of ad-hoc project artifacts.",
    "Use 'comment' for task-scoped discussion  -- prefer over amux_send for task-related topics. Comments notify relevant task subscribers by default; set notify:false or silent:true for quiet notes.",
    "Use 'archive' to move done items that are no longer needed for ongoing implementation out of the active backlog.",
  ],
  inputSchema: objectSchema(
    {
      action: enumProp(TASK_ACTIONS, "Action to perform"),
      // add
      title: optionalStringProp("Task title (required for add)"),
      description: optionalStringProp("Task description or acceptance criteria"),
      itemType: enumProp(ITEM_TYPES, "Item type: task (default), initiative, milestone, bug, chore, spec"),
      files: {
        type: "array",
        description: "Related file paths (auto-reserved on pick)",
        items: stringProp(),
      },
      dependsOn: {
        type: "array",
        description: "Task IDs this task depends on (for add)",
        items: stringProp(),
      },
      parentId: optionalStringProp("Parent item ID for hierarchy (for add)"),
      order: { type: "number", description: "Sort order within siblings (for add)" },
      urgent: optionalBoolProp("If true, prepend to backlog instead of append"),
      // assign, pick, done, drop, block
      id: optionalStringProp("Task ID (e.g. TASK-01)"),
      to: optionalStringProp("Agent name to assign the task to"),
      reason: optionalStringProp("Reason for blocking, or approach note for pick"),
      summary: optionalStringProp("Summary for review or done. For review, include commit/branch, diff summary, tests run, and known risks."),
      content: optionalStringProp("Comment text (for comment), or markdown spec content (for plan)"),
      notify: optionalBoolProp("For comment: notify task subscribers (default true). Set false for silent comments."),
      silent: optionalBoolProp("For comment: if true, do not notify task subscribers."),
      // list
      status: { type: "string", description: "Filter by status: todo, assigned, in-progress, review, done, blocked", enum: [...TASK_STATUSES] },
    },
    ["action"],
  ),

  async execute(ctx, params) {
    switch (params.action) {
      case "add": return executeAdd(ctx, params);
      case "list": return executeList(ctx, params);
      case "show": return executeShow(ctx, params);
      case "comment": return executeComment(ctx, params);
      case "plan": return executePlan(ctx, params);
      case "edit-plan": return executeEditPlan(ctx, params);
      case "summary": return executeSummary(ctx);
      case "archive": return executeArchive(ctx);
      case "assign": return executeAssign(ctx, params);
      case "pick": return executePick(ctx, params);
      case "review": return executeReview(ctx, params);
      case "done": return executeDone(ctx, params);
      case "drop": return executeDrop(ctx, params);
      case "block": return executeBlock(ctx, params);
      default: throw new Error(`Unknown action: ${params.action}`);
    }
  },
};
