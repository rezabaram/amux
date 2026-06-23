/**
 * amux — Notification Planning Service
 *
 * Computes notification recipient/message/metadata plans for task comments,
 * discussion activity, and assignments. Framework-agnostic — adapters
 * (Pi, CLI, etc.) execute the plans via sendToInbox / updateAgent.
 */

import {
  type InboxMessage,
  newMessageId,
  taskCommentNotificationMessage,
  discussionNotificationMessage,
} from "./messaging.ts";
import { resolveTaskCommentSubscribers, type TaskComment } from "./task-comments.ts";
import { type BacklogItem } from "./backlog.ts";
import { type Discussion } from "./discussions.ts";
import { type AgentInfo, shouldSignalAgent } from "./registry.ts";

// ─── Plan Type ────────────────────────────────────────────────

export interface NotificationPlan {
  /** Target agent ID. */
  recipientId: string;
  /** Target agent session (delivery target). */
  recipientSession: string;
  /** Target agent display name. */
  recipientName: string;
  /** Whether the target should be flagged for attention (attentionPending). */
  shouldSignal: boolean;
  /** Pre-built inbox message (caller delivers via sendToInbox). */
  message: Omit<InboxMessage, "id" | "timestamp" | "from" | "fromName" | "fromRole" | "fromSession">;
}

// ─── Task Comments ────────────────────────────────────────────

export interface TaskCommentNotificationArgs {
  task: BacklogItem;
  comment: TaskComment;
  previousComments: TaskComment[];
  agents: AgentInfo[];
  senderId: string;
  senderName: string;
  senderRole?: string;
  senderSession: string;
  /** Suppress notification? (e.g. silent: true or notify: false) */
  skip?: boolean;
}

/**
 * Plan notifications for a new task comment. Returns subscribers
 * (excluding sender) with pre-built messages. Returns [] if skip is true.
 */
export function planTaskCommentNotifications(
  args: TaskCommentNotificationArgs,
): NotificationPlan[] {
  if (args.skip) return [];

  const recipients = resolveTaskCommentSubscribers(
    args.task,
    args.previousComments,
    args.agents,
    args.senderId,
    args.comment.text,
  );

  return recipients.map((r) => {
    const shouldSignal = shouldSignalAgent(r);
    const preview = args.comment.text.length > 160
      ? args.comment.text.slice(0, 157) + "..."
      : args.comment.text;
    return {
      recipientId: r.id,
      recipientSession: r.session ?? args.senderSession,
      recipientName: r.name,
      shouldSignal,
      message: {
        from: args.senderId,
        fromName: args.senderName,
        fromRole: args.senderRole,
        fromSession: args.senderSession,
        message: taskCommentNotificationMessage({
          taskId: args.task.id,
          taskTitle: args.task.title,
          authorName: args.senderName,
          preview,
        }),
        category: "task-comment",
        taskId: args.task.id,
        notificationType: "task-comment",
      },
    };
  });
}

// ─── Discussions ──────────────────────────────────────────────

export interface DiscussionNotificationArgs {
  discussion: Discussion;
  action: "started" | "posted" | "closed";
  senderId: string;
  senderName: string;
  senderRole?: string;
  senderSession: string;
  /** Suppress notification? */
  skip?: boolean;
}

/**
 * Plan notifications for a discussion event. Returns participants
 * (excluding sender) with pre-built messages. Returns [] if skip is true.
 */
export function planDiscussionNotifications(
  args: DiscussionNotificationArgs,
): NotificationPlan[] {
  if (args.skip) return [];

  const targets = args.discussion.participants.filter((p) => p.id !== args.senderId);

  return targets.map((t) => ({
    recipientId: t.id,
    recipientSession: t.session ?? args.senderSession,
    recipientName: t.name,
    shouldSignal: true,  // discussion activity always signals
    message: {
      from: args.senderId,
      fromName: args.senderName,
      fromRole: args.senderRole,
      fromSession: args.senderSession,
      message: discussionNotificationMessage({
        action: args.action,
        discussionId: args.discussion.id,
        topic: args.discussion.topic,
        authorName: args.senderName,
      }),
      category: args.discussion.kind === "brainstorm" ? "brainstorm" : "fyi",
      notificationType: `discussion-${args.action}`,
      discussionId: args.discussion.id,
    },
  }));
}
