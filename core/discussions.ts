/**
 * amux — Multi-party Discussions and Future Channels
 *
 * A first-class, outcome-oriented communication primitive for retros,
 * brainstorms, meetings, and design jams — collaboration that is
 * cross-cutting (not task-scoped) but bounded in lifecycle.
 *
 * Design (see SPEC-15):
 *   - A *discussion* is a closeable channel thread: open → closed-with-summary.
 *   - Storage is append-only JSONL per channel, replayed to derive state.
 *     Append-only line writes are crash-safe and naturally concurrent-tolerant
 *     (same pattern as task comments + journal).
 *   - State is the source of truth: read from files, no in-memory cache.
 *   - Types are channel-compatible so future long-running named channels can
 *     reuse the same event log without a migration.
 *
 * Scope of this module (core only — Pi/adapter wiring is separate):
 *   types, JSONL event storage/replay, DISC-NN ID allocation, start/post/
 *   list/show/close, close-summary validation, open-summary helper.
 *
 * Boundary: task-scoped work uses task comments; cross-cutting/team discussion
 * uses discussions; durable curated knowledge goes to journal/WoW/context.
 *
 * Pi-independent — no framework or adapter dependencies.
 */

import {
  sessionFile,
  readJsonlSync,
  appendJsonlSync,
  truncatePreview,
  formatTimestamp,
} from "./storage.ts";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────

/** Kind of discussion/channel. `channel` is reserved for future long-running channels. */
export type ChannelKind = "discussion" | "retro" | "brainstorm" | "design" | "sync" | "channel";

/** Lifecycle status of a channel. MVP discussions: open → closed. */
export type ChannelStatus = "open" | "closed";

/**
 * Audience mode — who a discussion is for. First-class because it defines
 * notification/participation semantics, independent of the resolved snapshot.
 *
 * - `all`: all same-session agents at creation time (plus creator). Retros,
 *   team brainstorms.
 * - `agents`: an explicit set of same-session agents (plus creator). Focused
 *   design jams.
 *
 * The resolved participant snapshot is always persisted alongside the mode so
 * notifications are deterministic even if team presence changes later; the
 * mode records intent and leaves room for future channel membership.
 */
export type ChannelAudience = "all" | "agents";

/** A participant in a channel (resolved at creation/post time from the registry). */
export interface ChannelParticipant {
  session: string;
  id: string;
  name: string;
  role?: string;
}

/**
 * An append-only event in a channel's history.
 *
 * `channel` is embedded on `created` and `closed` events so the log is
 * self-describing (status/topic/participants can be reconstructed by replay
 * even if the structure evolves). `posted` events carry only the post body.
 */
export interface ChannelEvent {
  eventId: string;
  type: "created" | "posted" | "closed";
  timestamp: string; // ISO 8601
  authorId: string;
  authorName: string;
  authorSession: string;
  /** Post body (posted events only). */
  content?: string;
  /** Close outcome (closed events only). Required to close. */
  summary?: string;
  /** Channel snapshot, embedded on created/closed events. */
  channel?: {
    id: string;
    topic: string;
    kind: ChannelKind;
    status: ChannelStatus;
    audience: ChannelAudience;
    participants: ChannelParticipant[];
  };
}

/** A single post, projected from a `posted` event for display/API. */
export interface DiscussionPost {
  eventId: string;
  timestamp: string;
  authorId: string;
  authorName: string;
  authorSession: string;
  content: string;
}

/**
 * The projected state of a discussion, derived by replaying its event log.
 * This is a read model; the JSONL log is the source of truth.
 */
export interface Discussion {
  id: string;
  topic: string;
  kind: ChannelKind;
  status: ChannelStatus;
  audience: ChannelAudience;
  participants: ChannelParticipant[];
  createdAt: string;
  createdBy: string;
  /** Present only after a close event. */
  closedAt?: string;
  closedBy?: string;
  summary?: string;
  posts: DiscussionPost[];
}

/** Compact metadata for list/open-summary views (no post bodies). */
export interface DiscussionSummary {
  id: string;
  topic: string;
  kind: ChannelKind;
  status: ChannelStatus;
  audience: ChannelAudience;
  postCount: number;
  participantNames: string[];
  createdAt: string;
  /** Timestamp of the most recent event (post or close). */
  lastActivityAt: string;
  /** Present only when closed. */
  closedAt?: string;
  summary?: string;
}

// ─── Paths ───────────────────────────────────────────────────

function discussionsDir(session: string): string {
  return sessionFile(session, "artifacts", "project", "discussions");
}

function discussionPath(session: string, id: string): string {
  return sessionFile(session, "artifacts", "project", "discussions", `${id}.jsonl`);
}

// ─── ID Allocation ───────────────────────────────────────────

const DISC_ID_RE = /^DISC-(\d+)\.jsonl$/;

/** Extract the bare DISC-NN id from a JSONL filename, or null if it doesn't match. */
function idFromFilename(name: string): string | null {
  const match = name.match(DISC_ID_RE);
  return match ? `DISC-${match[1]}` : null;
}

/**
 * Allocate the next monotonic discussion ID by scanning existing files.
 * IDs never reuse an existing file's number, even after close/archive,
 * so logs and references stay stable.
 */
export function nextDiscussionId(session: string): string {
  let maxNum = 0;
  try {
    const entries = readdirSync(discussionsDir(session));
    for (const name of entries) {
      const bareId = idFromFilename(name);
      if (bareId) {
        const num = parseInt(bareId.slice("DISC-".length), 10);
        if (num > maxNum) maxNum = num;
      }
    }
  } catch {
    // Directory doesn't exist yet — start at DISC-01.
  }
  return `DISC-${String(maxNum + 1).padStart(2, "0")}`;
}

// ─── State Replay ────────────────────────────────────────────

/**
 * Replay a discussion's JSONL event log into projected state.
 * Returns null if the discussion does not exist (no events).
 *
 * Replay semantics:
 *   - `created` seeds id/topic/kind/participants.
 *   - `posted` appends to posts.
 *   - `closed` sets status/summary/closedAt and embeds the final snapshot.
 * Unknown/malformed events are skipped (readJsonlSync already drops bad lines).
 */
export function readDiscussion(session: string, id: string): Discussion | null {
  const events = readJsonlSync<ChannelEvent>(discussionPath(session, id));
  if (events.length === 0) return null;
  return replayEvents(id, events);
}

/** Pure replay helper — exported for unit testing without touching the filesystem. */
export function replayEvents(id: string, events: ChannelEvent[]): Discussion | null {
  if (events.length === 0) return null;

  const created = events.find((e) => e.type === "created");
  if (!created?.channel) return null;

  const posts: DiscussionPost[] = [];
  for (const e of events) {
    if (e.type === "posted" && e.content !== undefined) {
      posts.push({
        eventId: e.eventId,
        timestamp: e.timestamp,
        authorId: e.authorId,
        authorName: e.authorName,
        authorSession: e.authorSession,
        content: e.content,
      });
    }
  }

  const closed = events.find((e) => e.type === "closed");
  const channel = (closed?.channel ?? created.channel);

  return {
    id,
    topic: channel.topic,
    kind: channel.kind,
    status: channel.status,
    audience: channel.audience,
    participants: channel.participants,
    createdAt: created.timestamp,
    createdBy: created.authorName,
    closedAt: closed?.timestamp,
    closedBy: closed?.authorName,
    summary: closed?.summary,
    posts,
  };
}

/**
 * Replay all discussions in a session, ordered by creation time.
 * Useful for list views; skips any malformed/empty logs.
 */
export function readAllDiscussions(session: string): Discussion[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(discussionsDir(session));
  } catch {
    return [];
  }
  const discussions: Discussion[] = [];
  for (const name of entries) {
    const id = idFromFilename(name);
    if (!id) continue;
    const d = readDiscussion(session, id);
    if (d) discussions.push(d);
  }
  discussions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return discussions;
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate that a close summary is non-empty and meaningful.
 * SPEC-15: summary is required to close — it bridges the ephemeral discussion
 * to durable knowledge and prevents zombie prompt weight from never-closed
 * threads. Returns an error message string, or null when valid.
 */
export function validateCloseSummary(summary: string | undefined): string | null {
  const trimmed = (summary ?? "").trim();
  if (trimmed.length === 0) {
    return "A summary is required to close a discussion (captured as the durable outcome).";
  }
  if (trimmed.length > 2000) {
    return "Close summary is too long (max 2000 characters).";
  }
  return null;
}

/** Validate a post body. Returns an error message string, or null when valid. */
export function validatePostContent(content: string | undefined): string | null {
  const trimmed = (content ?? "").trim();
  if (trimmed.length === 0) {
    return "Post content cannot be empty.";
  }
  if (trimmed.length > 8000) {
    return "Post content is too long (max 8000 characters).";
  }
  return null;
}

/** Validate a discussion topic. Returns an error message string, or null when valid. */
export function validateTopic(topic: string | undefined): string | null {
  const trimmed = (topic ?? "").trim();
  if (trimmed.length === 0) {
    return "Discussion topic cannot be empty.";
  }
  if (trimmed.length > 200) {
    return "Topic is too long (max 200 characters).";
  }
  return null;
}

// ─── Lifecycle Operations ────────────────────────────────────

/** Author snapshot for an event — resolved by the adapter from the joined agent. */
export interface Author {
  id: string;
  name: string;
  session: string;
}

/**
 * Start a new open discussion. Appends a `created` event.
 * `participants` should be pre-resolved by the adapter (default: all session
 * agents including the creator, de-duplicated by id).
 *
 * Returns the new discussion id (allocated via nextDiscussionId).
 */
export function startDiscussion(
  session: string,
  args: {
    topic: string;
    kind?: ChannelKind;
    /** Audience mode (default `all`). Persists alongside the resolved snapshot. */
    audience?: ChannelAudience;
    /** Pre-resolved participant snapshot (see resolveDiscussionParticipants). */
    participants: ChannelParticipant[];
    author: Author;
    /** Optional agenda/initial body appended as the first `posted` event. */
    content?: string;
  },
): string {
  const topicErr = validateTopic(args.topic);
  if (topicErr) throw new Error(topicErr);

  if (args.content && args.content.trim()) {
    const contentErr = validatePostContent(args.content);
    if (contentErr) throw new Error(contentErr);
  }

  const id = nextDiscussionId(session);
  const kind: ChannelKind = args.kind ?? "discussion";
  const audience: ChannelAudience = args.audience ?? "all";
  const now = new Date().toISOString();

  // Creator is always a participant; de-duplicate by id defensively so the
  // persisted snapshot is stable regardless of what the adapter passes.
  const participants = withCreatorIncluded(args.participants, args.author);

  const createdEvent: ChannelEvent = {
    eventId: newEventId(),
    type: "created",
    timestamp: now,
    authorId: args.author.id,
    authorName: args.author.name,
    authorSession: args.author.session,
    channel: {
      id,
      topic: args.topic.trim(),
      kind,
      status: "open",
      audience,
      participants,
    },
  };
  appendJsonlSync(discussionPath(session, id), createdEvent);

  if (args.content && args.content.trim()) {
    appendJsonlSync(discussionPath(session, id), {
      eventId: newEventId(),
      type: "posted",
      timestamp: new Date().toISOString(),
      authorId: args.author.id,
      authorName: args.author.name,
      authorSession: args.author.session,
      content: args.content.trim(),
    } satisfies ChannelEvent);
  }

  return id;
}

/**
 * Append a post to a discussion. Throws if the discussion does not exist or
 * is already closed. Returns the projected discussion (or null if not found).
 */
export function postToDiscussion(
  session: string,
  id: string,
  args: {
    content: string;
    author: Author;
  },
): Discussion | null {
  const contentErr = validatePostContent(args.content);
  if (contentErr) throw new Error(contentErr);

  const existing = readDiscussion(session, id);
  if (!existing) return null;
  if (existing.status === "closed") {
    throw new Error(`Discussion ${id} is closed and cannot receive new posts.`);
  }

  const event: ChannelEvent = {
    eventId: newEventId(),
    type: "posted",
    timestamp: new Date().toISOString(),
    authorId: args.author.id,
    authorName: args.author.name,
    authorSession: args.author.session,
    content: args.content.trim(),
  };
  appendJsonlSync(discussionPath(session, id), event);

  return readDiscussion(session, id);
}

/**
 * Close a discussion with a required summary. Appends a `closed` event that
 * embeds the final channel snapshot (status: closed). Throws if the summary
 * is missing/empty, the discussion does not exist, or it is already closed.
 */
export function closeDiscussion(
  session: string,
  id: string,
  args: {
    summary: string;
    author: Author;
  },
): Discussion | null {
  const summaryErr = validateCloseSummary(args.summary);
  if (summaryErr) throw new Error(summaryErr);

  const existing = readDiscussion(session, id);
  if (!existing) return null;
  if (existing.status === "closed") {
    throw new Error(`Discussion ${id} is already closed.`);
  }

  const event: ChannelEvent = {
    eventId: newEventId(),
    type: "closed",
    timestamp: new Date().toISOString(),
    authorId: args.author.id,
    authorName: args.author.name,
    authorSession: args.author.session,
    summary: args.summary.trim(),
    channel: {
      id: existing.id,
      topic: existing.topic,
      kind: existing.kind,
      status: "closed",
      audience: existing.audience,
      participants: existing.participants,
    },
  };
  appendJsonlSync(discussionPath(session, id), event);

  return readDiscussion(session, id);
}

// ─── List / Summary Views ────────────────────────────────────

/** Project a discussion into a compact summary (no post bodies). */
export function summarizeDiscussion(d: Discussion): DiscussionSummary {
  const activityTimestamps = [
    d.createdAt,
    ...d.posts.map((p) => p.timestamp),
    ...(d.closedAt ? [d.closedAt] : []),
  ];
  const lastActivityAt = activityTimestamps.sort().at(-1)!;
  return {
    id: d.id,
    topic: d.topic,
    kind: d.kind,
    status: d.status,
    audience: d.audience,
    postCount: d.posts.length,
    participantNames: d.participants.map((p) => p.name),
    createdAt: d.createdAt,
    lastActivityAt,
    closedAt: d.closedAt,
    summary: d.summary,
  };
}

/**
 * Summaries of all discussions, newest activity first.
 * Closed discussions are included so callers can show "recent closed".
 */
export function listDiscussions(session: string): DiscussionSummary[] {
  return readAllDiscussions(session)
    .map(summarizeDiscussion)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * Open discussions only, as compact summaries, newest activity first.
 * This is the shape injected into agent prompts (metadata only — never post
 * bodies). Returns [] when there are no open discussions.
 */
export function openDiscussionSummaries(session: string): DiscussionSummary[] {
  return listDiscussions(session).filter((d) => d.status === "open");
}

// ─── Rendering ───────────────────────────────────────────────

/**
 * Render a discussion for `show` / display: metadata header, status, summary
 * (if closed), participants, and the full post thread.
 */
export function renderDiscussion(d: Discussion): string {
  const lines: string[] = [];
  lines.push(`${d.id} [${d.status}] ${d.topic}`);
  lines.push(`Kind: ${d.kind} · Audience: ${d.audience}`);
  lines.push(`Created: ${d.createdAt} by ${d.createdBy}`);
  lines.push(`Participants: ${d.participants.map((p) => p.name).join(", ") || "(none)"}`);
  if (d.status === "closed") {
    lines.push(`Closed: ${d.closedAt ?? "?"}${d.closedBy ? ` by ${d.closedBy}` : ""}`);
    if (d.summary) lines.push(`Summary: ${d.summary}`);
  }
  lines.push("");
  if (d.posts.length === 0) {
    lines.push("(no posts yet)");
  } else {
    for (const p of d.posts) {
      const date = formatTimestamp(p.timestamp);
      lines.push(`[${date}] ${p.authorName}: ${p.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a compact one-line-per-discussion list for `list`.
 * Example: `DISC-03 [open] retro: v1.2 retro — 5 posts, Lead, Developer`
 */
export function renderDiscussionList(summaries: DiscussionSummary[]): string {
  if (summaries.length === 0) return "(no discussions)";
  return summaries
    .map((s) => {
      const parts = [
        `${s.id} [${s.status}]`,
        `${s.kind}:`,
        s.topic,
        `— ${s.audience}, ${s.postCount} post${s.postCount === 1 ? "" : "s"},`,
        s.participantNames.join(", ") || "(no participants)",
      ];
      return parts.join(" ");
    })
    .join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────

/** Generate a stable event id (UUIDv4). */
function newEventId(): string {
  return randomUUID();
}

/** Normalize an audience value, defaulting to `all`. */
export function normalizeAudience(audience?: ChannelAudience): ChannelAudience {
  return audience === "agents" ? "agents" : "all";
}

/**
 * Resolve the participant snapshot for a discussion from its audience mode.
 * Centralizes the SPEC-15 rule so the adapter and tests share one definition.
 *
 * - `all`: all same-session agents (`allAgents`), plus the creator.
 * - `agents`: the explicitly provided agents, plus the creator.
 * The creator is always included and the result is de-duplicated by agent id.
 */
export function resolveDiscussionParticipants(
  audience: ChannelAudience,
  creator: Author,
  allAgents: ChannelParticipant[],
  explicitAgents: ChannelParticipant[] = [],
): ChannelParticipant[] {
  const base = audience === "agents" ? explicitAgents : allAgents;
  return withCreatorIncluded(base, creator);
}

/** De-duplicate participants by id and ensure the creator is present. */
function withCreatorIncluded(
  participants: ChannelParticipant[],
  creator: Author,
): ChannelParticipant[] {
  const byId = new Map<string, ChannelParticipant>();
  for (const p of participants) byId.set(p.id, p);
  const existingCreator = byId.get(creator.id);
  byId.set(creator.id, {
    ...existingCreator,
    session: creator.session,
    id: creator.id,
    name: creator.name,
  });
  return [...byId.values()];
}

/** Compact preview of post content, for notifications. */
export function postPreview(content: string, maxLength = 160): string {
  return truncatePreview(content, maxLength);
}
