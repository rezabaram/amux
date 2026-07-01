/**
 * amutix — Attention digest (INIT-16)
 *
 * Pure, Pi-independent computation of "what needs this agent's attention right
 * now", derived from current state. The per-agent heartbeat uses this to decide
 * whether to self-wake an idle agent, and to render compact pointers ("where to
 * look") rather than bare pings or directions.
 *
 * Design (see SPEC-22):
 *   - The imperative `attentionPending` flag (set by initiators) is the trigger.
 *   - This digest is the rendering: derived, never latched, recomputed each tick.
 *
 * The digest only ever contains pointers to state; it never instructs the agent.
 */

import type { InboxMessage } from "./messaging.ts";
import type { AgentInfo } from "./registry.ts";
import { deriveCoordinationSignals } from "./next.ts";

// ─── Types ───────────────────────────────────────────────────

export type AttentionKind =
  | "message" // unread inbox message addressed to me
  | "assigned" // task assigned to me, not yet started
  | "active" // task I picked and still own in-progress
  | "reply" // pending reply I am waiting on (responseRequired, unanswered)
  | "review" // task where review was explicitly requested from me
  | "blocked" // blocked work I own
  | "reservation" // reservation conflict relevant to my planned files
  | "discussion" // open discussion activity involving me
  | "flag"; // initiator flagged me but no specific derived item matched

export interface AttentionEntry {
  kind: AttentionKind;
  /** Compact pointer the agent can act on (task id, message id, etc.). */
  pointer: string;
  /** One-line summary for the wake notice. */
  summary: string;
  /** Inbox filename for message entries; used by adapters to mark delivered. */
  filename?: string;
  /** Raw inbox message for message entries; used by adapters to append history. */
  message?: InboxMessage;
  /** Stable signature key; changes when derived signal meaning changes (e.g. dependencies become ready). */
  signatureKey?: string;
}

/**
 * `amutix_next` uses this same digest as its attention source of truth. The
 * cockpit may enrich entries with task/message/reply IDs for structured
 * details, but it must not introduce a second attention model or latch copies
 * of instructions that can go stale.
 */
export type AttentionDigestSource = AttentionEntry;

// ─── Digest ──────────────────────────────────────────────────

/**
 * Compute the set of items needing this agent's attention, derived purely from
 * current session state. Returns pointers only — never directions.
 *
 * `agent` is the calling agent's own record; its `attentionPending` flag gates
 * the review section (the initiator decides who reviews via notifyTarget).
 */
export async function computeAttentionDigest(
  session: string,
  agentId: string,
  agent: Pick<AgentInfo, "attentionPending">,
): Promise<AttentionEntry[]> {
  const digest = await deriveCoordinationSignals({ session, agentId, agentName: "", roleName: undefined });
  return digest.signals
    .filter((signal) => ["message", "assigned-ready", "assigned-waiting", "active", "awaiting-reply", "targeted-review", "blocked", "reservation-conflict", "discussion", "flag"].includes(signal.kind))
    .map((signal) => {
      const entry: AttentionEntry = {
        kind: signal.kind === "assigned-ready" || signal.kind === "assigned-waiting" ? "assigned"
          : signal.kind === "awaiting-reply" ? "reply"
          : signal.kind === "targeted-review" ? "review"
          : signal.kind === "reservation-conflict" ? "reservation"
          : signal.kind,
        pointer: signal.taskId || signal.replyId || signal.messageId || signal.path || signal.discussionId || "",
        summary: signal.summary,
        message: signal.message,
        signatureKey: signal.key,
      };
      const recoverable = digest.recoverableMessages.find(({ msg }) => msg.id === signal.messageId);
      if (recoverable) entry.filename = recoverable.filename;
      return entry;
    });
}

// ─── Signature (dedup / new-attention detection) ─────────────

/**
 * Stable signature of a digest, for detecting new/changed attention since the
 * last delivery. Order-independent (sorted) so reordering doesn't read as change.
 */
export function attentionSignature(entries: AttentionEntry[]): string {
  return entries
    .map((e) => e.signatureKey || `${e.kind}:${e.pointer}`)
    .sort()
    .join("|");
}

// ─── Wake decision ───────────────────────────────────────────

/** Minimum gap between unchanged re-deliveries (bounds nag on interrupted turns). */
export const ATTENTION_REDELIVER_MS = 120_000;

/**
 * Decide whether to (re-)wake, given the current agent state and digest.
 *
 * - Fresh attention (never delivered)            → wake
 * - New/changed attention since last delivery    → wake
 * - Not yet acted on (interrupted/missed turn)   → wake, throttled by REDELIVER_MS
 * - Acted on (turn completed) + unchanged        → suppress (no nag)
 */
export function shouldDeliverAttention(args: {
  digest: AttentionEntry[];
  signature: string;
  deliveredAt?: string; // agent.attentionDeliveredAt
  deliveredSig?: string; // agent.attentionDigestSig
  lastTurnEndedAt?: string; // agent.lastTurnEndedAt
  availability?: AgentInfo["availability"];
  hasActiveWork?: boolean;
  now?: number; // injectable for tests
}): boolean {
  const { digest, signature, deliveredAt, deliveredSig, lastTurnEndedAt, availability, hasActiveWork = false, now = Date.now() } = args;
  if (digest.length === 0) return false;

  // Respect explicit focus/away and do not nag agents already working an active
  // task. A stale `working` state with no active work can still be woken below.
  if (availability === "focus" || availability === "away") return false;
  if (availability === "working" && hasActiveWork) return false;

  const hasReadyAssigned = digest.some((e) => e.signatureKey?.includes(":ready") || (e.kind === "assigned" && /dependencies met/.test(e.summary)));

  // Fresh: never delivered.
  if (!deliveredAt || !deliveredSig) return true;

  // Changed since last delivery.
  if (signature !== deliveredSig) return true;

  const sinceDeliver = now - new Date(deliveredAt).getTime();

  // Unchanged — did the agent get a chance to act since delivery?
  const actedSinceDelivery =
    !!lastTurnEndedAt && new Date(lastTurnEndedAt).getTime() > new Date(deliveredAt).getTime();
  if (actedSinceDelivery) {
    // Ready assigned work needs follow-through: if the assignee stayed idle and
    // did not pick/drop/block, re-surface the same pointer on a throttle until
    // the authoritative task state changes. Other unchanged attention remains
    // suppressed after the agent had a turn.
    return hasReadyAssigned && sinceDeliver >= ATTENTION_REDELIVER_MS;
  }

  // Not yet acted on (interrupted/missed) → bounded re-wake.
  return sinceDeliver >= ATTENTION_REDELIVER_MS;
}

// ─── Rendering ───────────────────────────────────────────────

/**
 * Render the digest as a compact wake notice: pointers only, no directions.
 * Used as the followUp body that the heartbeat sends to the idle agent.
 */
export function renderAttentionNotice(entries: AttentionEntry[]): string {
  const lines = entries.slice(0, 8).map((e) => `• ${e.summary}`);
  const more = entries.length > 8 ? `\n…and ${entries.length - 8} more` : "";
  return `You have outstanding attention:\n${lines.join("\n")}${more}`;
}
