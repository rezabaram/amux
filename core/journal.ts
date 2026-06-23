/**
 * amux — Journal System
 *
 * Append-only JSONL log for decisions, learnings, and progress.
 * Shared across all agents in a session.
 * Recent entries are injected into the system prompt (sliding window).
 *
 * File per session:
 *   journal.jsonl — one JSON object per line (append-only)
 */

import {
  sessionFile,
  readJsonlSync,
  appendJsonlSync,
  formatTimestamp,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

export interface JournalEntry {
  timestamp: string; // ISO 8601
  agent: string; // who wrote it
  agentId: string; // agent UUID
  type: "decision" | "learning" | "progress";
  content: string; // the actual entry
  context?: string; // optional context (e.g., task ID, topic)
}

// ─── Constants ───────────────────────────────────────────────

/** Number of recent journal entries injected into the system prompt. */
export const JOURNAL_WINDOW_SIZE = 10;

// ─── Paths ───────────────────────────────────────────────────

function journalPath(session: string): string {
  return sessionFile(session, "journal.jsonl");
}

// ─── Journal Operations ─────────────────────────────────────

/**
 * Append a journal entry to the session log.
 */
export function appendEntry(session: string, entry: JournalEntry): void {
  appendJsonlSync(journalPath(session), entry);
}

/**
 * Read journal entries from the session log.
 *
 * @param limit - Maximum number of entries to return (from the end). Default: all.
 * @param type - Filter by entry type. Default: all types.
 * @returns Entries in chronological order.
 */
export function readEntries(
  session: string,
  limit?: number,
  type?: JournalEntry["type"]
): JournalEntry[] {
  let entries = readJsonlSync<JournalEntry>(journalPath(session));

  if (type) {
    entries = entries.filter((e) => e.type === type);
  }

  if (limit && limit > 0) {
    entries = entries.slice(-limit);
  }

  return entries;
}

/**
 * Get recent journal entries for system prompt injection.
 * Returns the last N entries in chronological order.
 */
export function getRecentEntries(session: string, limit: number = JOURNAL_WINDOW_SIZE): JournalEntry[] {
  return readEntries(session, limit);
}

/**
 * Format a journal entry for display.
 * Returns a single-line string like:
 *   [2026-06-19 14:00] agent1 (decision): Use zod for validation
 */
export function formatEntry(entry: JournalEntry): string {
  const date = formatTimestamp(entry.timestamp);
  const ctx = entry.context ? ` [${entry.context}]` : "";
  return `[${date}] ${entry.agent} (${entry.type})${ctx}: ${entry.content}`;
}
