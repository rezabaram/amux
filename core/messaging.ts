/**
 * amux — File-Based Messaging (Crash-Safe)
 *
 * Message lifecycle:
 *   1. Sender writes .json to target's inbox (durable)
 *   2. Watcher picks up → appends to history → renames to .delivered
 *   3. pi.sendUserMessage() queues for processing
 *   4. agent_end → deletes .delivered files
 *
 * Crash recovery:
 *   - .json files → never picked up → deliver
 *   - .delivered files → queued but unconfirmed → redeliver
 *
 * History: all messages appended to messages.log (JSONL)
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  sessionFile,
  appendJsonlSync,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

export interface InboxMessage {
  id: string; // message UUID
  from: string; // sender agent UUID
  fromName: string; // sender display name
  fromRole?: string; // sender role (if any)
  fromSession: string; // sender session
  timestamp: string; // ISO 8601
  message: string; // message content
  category?: string; // intent hint: "urgent", "fyi", "brainstorm", "task-comment"
  taskId?: string; // optional related task ID for context
  notificationType?: string; // e.g. "task-comment"
  commentId?: string; // related task comment ID, when applicable
  preview?: string; // short preview for notification UIs/logs
  requiresAttention?: boolean; // whether recipient should reassess state
}

/**
 * Format a message's age relative to now.
 * Returns a human-readable string like "2m ago", "3h ago", "1d ago".
 * Used by adapters to display staleness context on delivered messages.
 */
export function formatMessageAge(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Paths ───────────────────────────────────────────────────

function inboxDir(session: string, agentId: string): string {
  return sessionFile(session, "inbox", agentId);
}

function historyPath(session: string): string {
  return sessionFile(session, "messages.log");
}

// ─── Inbox Operations ────────────────────────────────────────

/** Ensure the inbox directory exists. */
export function ensureInbox(session: string, agentId: string): void {
  mkdirSync(inboxDir(session, agentId), { recursive: true });
}

/**
 * Send a message to an agent's inbox.
 * Uses atomic write (tmp + rename) so watchers never see partial files.
 */
export function sendToInbox(
  session: string,
  targetId: string,
  message: InboxMessage
): void {
  const dir = inboxDir(session, targetId);
  mkdirSync(dir, { recursive: true });

  const base = `${Date.now()}-${message.id}`;
  const tmpFile = join(dir, `${base}.tmp`);
  const jsonFile = join(dir, `${base}.json`);

  writeFileSync(tmpFile, JSON.stringify(message, null, 2), "utf8");
  renameSync(tmpFile, jsonFile);
}

/**
 * Mark a message as delivered (rename .json → .delivered).
 * Prevents the watcher from picking it up again.
 */
export function markAsDelivered(
  session: string,
  agentId: string,
  filename: string
): void {
  const dir = inboxDir(session, agentId);
  const deliveredName = filename.replace(/\.json$/, ".delivered");
  try {
    renameSync(join(dir, filename), join(dir, deliveredName));
  } catch {
    // File may have been processed already
  }
}

/**
 * Get all pending messages (.json) and unconfirmed messages (.delivered).
 * Used on startup for crash recovery.
 */
export function getRecoverableMessages(
  session: string,
  agentId: string
): Array<{ msg: InboxMessage; filename: string }> {
  const dir = inboxDir(session, agentId);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".delivered"))
      .sort();
    return files.map((f) => ({
      msg: JSON.parse(readFileSync(join(dir, f), "utf8")) as InboxMessage,
      filename: f,
    }));
  } catch {
    return [];
  }
}

/**
 * Confirm all delivered messages — delete .delivered files.
 * Called on agent_end after processing completes.
 */
export function confirmDelivered(session: string, agentId: string): void {
  const dir = inboxDir(session, agentId);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".delivered"));
    for (const f of files) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // Already cleaned up
      }
    }
  } catch {
    // Inbox doesn't exist yet
  }
}

// ─── History ─────────────────────────────────────────────────

/**
 * Append a message to the session's history log (JSONL format).
 * Called when a message is first picked up (before processing).
 */
export function appendToHistory(session: string, message: InboxMessage): void {
  appendJsonlSync(historyPath(session), message);
}

// ─── Watcher ─────────────────────────────────────────────────

/**
 * Watch an inbox for new .json messages.
 * Calls onMessage when a new .json file appears.
 * Returns the FSWatcher (call .close() to stop).
 */
export function watchInbox(
  session: string,
  agentId: string,
  onMessage: (msg: InboxMessage, filename: string) => void
): FSWatcher {
  const dir = inboxDir(session, agentId);
  mkdirSync(dir, { recursive: true });

  return watch(dir, (eventType, filename) => {
    // Only process new .json files (not .tmp, .delivered)
    if (!filename || !filename.endsWith(".json")) return;

    try {
      const content = readFileSync(join(dir, filename), "utf8");
      const msg = JSON.parse(content) as InboxMessage;
      onMessage(msg, filename);
    } catch {
      // File may have been renamed/deleted already
    }
  });
}

/** Generate a unique message ID (128-bit UUID). */
export function newMessageId(): string {
  return randomUUID();
}
