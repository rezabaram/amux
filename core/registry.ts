/**
 * amux — Agent Registry, Roles, and Session Config
 *
 * Agents are keyed by UUID. Names are for human-friendly addressing.
 * Agents persist across restarts with online/offline status.
 *
 * Files per session:
 *   agents.json  — agent registry (keyed by UUID)
 *   roles.json   — role definitions (name + instructions)
 *   config.json  — session config (default model, etc.)
 */

import { randomUUID } from "node:crypto";

import {
  sessionFile,
  readJson,
  atomicWriteJson,
  listSessions,
  withJsonFile,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

export interface AgentInfo {
  id: string; // UUID — primary key, stable across restarts
  name: string; // human-friendly display name
  session: string; // amux session name
  role: string; // human-readable role description
  roleName?: string; // references a RoleDefinition name
  workspace?: string; // git worktree path
  model?: string; // preferred LLM model (e.g. anthropic/claude-sonnet-4)
  cwd: string;
  pane?: string; // tmux pane target (optional — only if tmux)
  pid: number;
  status: "online" | "offline";
  availability?: "idle" | "working" | "focus" | "away";
  statusMessage?: string; // freeform status message
  availabilityUpdatedAt?: string; // ISO 8601
  attentionPending?: boolean; // coalesced attention flag
  registeredAt: string; // ISO 8601
  lastHeartbeat: string; // ISO 8601
}

export type Registry = Record<string, AgentInfo>; // keyed by UUID

export interface RoleDefinition {
  name: string;
  description?: string; // short one-liner for display
  instructions: string;
}

export type RolesMap = Record<string, RoleDefinition>;

export interface SessionConfig {
  model?: string;
  mainRepo?: string; // path to the main git repo
  createdAt?: string;
}

export type AgentAddress = string;

// ─── Heartbeat / Presence ───────────────────────────────────

/** Expected interval between heartbeats (milliseconds). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Heartbeat TTL: an agent is considered stale after this duration
 * without a heartbeat (3× the heartbeat interval = 90 seconds).
 */
export const HEARTBEAT_TTL_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * Check whether an agent is effectively online.
 *
 * An agent is online only if its stored status is `"online"` AND its
 * last heartbeat falls within the TTL window.  Crashed agents whose
 * heartbeat has expired are treated as offline even though their
 * persisted status still says `"online"`.
 */
export function isEffectivelyOnline(agent: AgentInfo): boolean {
  if (agent.status !== "online") return false;
  const elapsed = Date.now() - new Date(agent.lastHeartbeat).getTime();
  return elapsed < HEARTBEAT_TTL_MS;
}

/**
 * Check whether an agent should receive a generic attention signal.
 * True only if the agent is effectively online, idle (or no availability set),
 * and does not already have a pending attention flag.
 */
export function shouldSignalAgent(agent: AgentInfo): boolean {
  return (
    isEffectivelyOnline(agent) &&
    (!agent.availability || agent.availability === "idle") &&
    !agent.attentionPending
  );
}

// ─── Paths ───────────────────────────────────────────────────

function registryPath(session: string): string {
  return sessionFile(session, "agents.json");
}

function rolesPath(session: string): string {
  return sessionFile(session, "roles.json");
}

function configPath(session: string): string {
  return sessionFile(session, "config.json");
}

// ─── Agent Registry ──────────────────────────────────────────

export async function readRegistry(session: string): Promise<Registry> {
  return readJson<Registry>(registryPath(session), {});
}

async function writeRegistry(session: string, data: Registry): Promise<void> {
  await atomicWriteJson(registryPath(session), data);
}

/** Generate a new agent UUID (128-bit, standard format). */
export function newAgentId(): string {
  return randomUUID();
}

/**
 * Register or update an agent in the registry.
 * Rejects duplicate names within the same session (case-insensitive).
 */
export async function registerAgent(session: string, agent: AgentInfo): Promise<void> {
  await withJsonFile<Registry>(registryPath(session), {}, (registry) => {
    const nameLower = agent.name.toLowerCase();
    for (const existing of Object.values(registry)) {
      if (existing.id !== agent.id && existing.name.toLowerCase() === nameLower) {
        throw new Error(
          `Duplicate agent name: "${agent.name}" already exists in session ` +
          `(as "${existing.name}"). Names must be unique within a session (case-insensitive).`
        );
      }
    }
    registry[agent.id] = agent;
    return registry;
  });
}

/** Remove an agent entirely from the registry. */
export async function removeAgent(session: string, id: string): Promise<void> {
  await withJsonFile<Registry>(registryPath(session), {}, (registry) => {
    delete registry[id];
    return registry;
  });
}

/**
 * Update specific fields of an agent.
 * If the name is being changed, enforces uniqueness (case-insensitive).
 */
export async function updateAgent(
  session: string,
  id: string,
  updates: Partial<AgentInfo>
): Promise<void> {
  await withJsonFile<Registry>(registryPath(session), {}, (registry) => {
    const agent = registry[id];
    if (!agent) return registry;
    // Enforce name uniqueness on rename
    if (updates.name && updates.name.toLowerCase() !== agent.name.toLowerCase()) {
      const nameLower = updates.name.toLowerCase();
      for (const existing of Object.values(registry)) {
        if (existing.id !== id && existing.name.toLowerCase() === nameLower) {
          throw new Error(
            `Duplicate agent name: "${updates.name}" already exists in session ` +
            `(as "${existing.name}"). Names must be unique within a session (case-insensitive).`
          );
        }
      }
    }
    Object.assign(agent, updates);
    return registry;
  });
}

/** Mark an agent as online with current pid/pane. */
export async function goOnline(
  session: string,
  id: string,
  pid: number,
  pane?: string
): Promise<void> {
  await updateAgent(session, id, {
    status: "online",
    pid,
    pane,
    lastHeartbeat: new Date().toISOString(),
  });
}

/** Mark an agent as offline. */
export async function goOffline(session: string, id: string): Promise<void> {
  await updateAgent(session, id, { status: "offline" });
}

/** Update heartbeat timestamp and optionally status. */
export async function updateHeartbeat(
  session: string,
  id: string,
  status?: "online" | "offline"
): Promise<void> {
  const updates: Partial<AgentInfo> = { lastHeartbeat: new Date().toISOString() };
  if (status) updates.status = status;
  await updateAgent(session, id, updates);
}

// ─── Lookups ─────────────────────────────────────────────────

/** Find an agent by name within a session (case-insensitive). */
export async function findByName(
  session: string,
  name: string
): Promise<AgentInfo | null> {
  const registry = await readRegistry(session);
  const nameLower = name.toLowerCase();
  return Object.values(registry).find((a) => a.name.toLowerCase() === nameLower) ?? null;
}

/** Find an agent by UUID within a session. */
export async function findById(
  session: string,
  id: string
): Promise<AgentInfo | null> {
  const registry = await readRegistry(session);
  return registry[id] ?? null;
}

/** Get all effectively-online agents in a session (heartbeat within TTL). */
export async function getOnlineAgents(session: string): Promise<AgentInfo[]> {
  const registry = await readRegistry(session);
  return Object.values(registry).filter(isEffectivelyOnline);
}

/** Get all effectively-offline agents in a session (offline or stale heartbeat). */
export async function getOfflineAgents(session: string): Promise<AgentInfo[]> {
  const registry = await readRegistry(session);
  return Object.values(registry).filter((a) => !isEffectivelyOnline(a));
}

/** Get all agents across all sessions. */
export async function readAllRegistries(): Promise<AgentInfo[]> {
  const allAgents: AgentInfo[] = [];
  const sessions = await listSessions();
  for (const session of sessions) {
    const registry = await readRegistry(session);
    for (const agent of Object.values(registry)) {
      agent.session = agent.session || session;
      allAgents.push(agent);
    }
  }
  return allAgents;
}

/**
 * Resolve an agent address: "name" (same session) or "session/name" (cross-session).
 * Returns null if not found.
 */
export async function resolveAgent(
  address: string,
  defaultSession: string
): Promise<AgentInfo | null> {
  const { session, name } = parseAddress(address, defaultSession);
  return findByName(session, name);
}

// ─── Roles ───────────────────────────────────────────────────

export async function readRoles(session: string): Promise<RolesMap> {
  return readJson<RolesMap>(rolesPath(session), {});
}

async function writeRoles(session: string, roles: RolesMap): Promise<void> {
  await atomicWriteJson(rolesPath(session), roles);
}

export async function getRole(session: string, name: string): Promise<RoleDefinition | null> {
  const roles = await readRoles(session);
  return roles[name] ?? null;
}

export async function addRole(session: string, role: RoleDefinition): Promise<void> {
  await withJsonFile<RolesMap>(rolesPath(session), {}, (roles) => {
    roles[role.name] = role;
    return roles;
  });
}

export async function removeRole(session: string, name: string): Promise<boolean> {
  let existed = false;
  await withJsonFile<RolesMap>(rolesPath(session), {}, (roles) => {
    existed = !!roles[name];
    if (existed) delete roles[name];
    return roles;
  });
  return existed;
}

// ─── Session Config ──────────────────────────────────────────

export async function readSessionConfig(session: string): Promise<SessionConfig> {
  return readJson<SessionConfig>(configPath(session), {});
}

export async function writeSessionConfig(
  session: string,
  config: SessionConfig
): Promise<void> {
  await atomicWriteJson(configPath(session), config);
}

// ─── Addressing ──────────────────────────────────────────────

export function formatAddress(session: string, name: string): string {
  return `${session}/${name}`;
}

export function parseAddress(
  address: string,
  defaultSession: string
): { session: string; name: string } {
  const i = address.indexOf("/");
  return i === -1
    ? { session: defaultSession, name: address }
    : { session: address.slice(0, i), name: address.slice(i + 1) };
}
