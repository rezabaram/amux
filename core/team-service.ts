/**
 * amutix — Team topology and workspace planning services
 *
 * Framework-neutral helpers for lead-managed team composition. These services
 * compute and validate registry/workspace state without Pi UI assumptions.
 * Filesystem/git mutation is deliberately not performed here; callers can use
 * the returned plans and human-action text to decide what to do next.
 */

import { resolve, normalize } from "node:path";

import { readBacklog, type BacklogItem } from "./backlog.ts";
import {
  findById,
  findByName,
  isEffectivelyOnline,
  readRegistry,
  readRoles,
  readSessionConfig,
  updateAgent,
  type AgentInfo,
  type RoleDefinition,
} from "./registry.ts";
import { getReservations, reservationTaskId } from "./reservations.ts";
import { deriveWorktreePath } from "./setup-service.ts";

export interface AgentTopologyUpdate {
  role?: string;
  roleName?: string;
  model?: string;
  cwd?: string;
  workspace?: string;
  statusMessage?: string;
}

export interface AgentWorkSummary {
  active: Array<Pick<BacklogItem, "id" | "title" | "status">>;
  assigned: Array<Pick<BacklogItem, "id" | "title" | "status">>;
  review: Array<Pick<BacklogItem, "id" | "title" | "status">>;
  blocked: Array<Pick<BacklogItem, "id" | "title" | "status">>;
}

export interface AgentTopologyView {
  id: string;
  name: string;
  role: string;
  roleName?: string;
  model?: string;
  cwd: string;
  workspace?: string;
  status: AgentInfo["status"];
  availability?: AgentInfo["availability"];
  statusMessage?: string;
  effectivelyOnline: boolean;
  lastHeartbeat: string;
  work: AgentWorkSummary;
}

export interface TeamTopologyView {
  session: string;
  mainRepo?: string;
  agents: AgentTopologyView[];
  roles: Record<string, RoleDefinition>;
}

export type TeamTopologyRiskKind =
  | "shared-cwd"
  | "shared-workspace"
  | "implementation-in-main-worktree"
  | "missing-workspace"
  | "stale-reservation";

export interface TeamTopologyRisk {
  kind: TeamTopologyRiskKind;
  severity: "low" | "medium" | "high";
  summary: string;
  agentIds: string[];
  path?: string;
  reservationPath?: string;
  taskId?: string;
}

export interface WorkspacePlanOptions {
  repoPath: string;
  agentName: string;
  existingPaths?: string[];
  existingBranches?: string[];
  existingWorktreePaths?: string[];
}

export interface WorkspacePlan {
  agentName: string;
  repoPath: string;
  wsPath: string;
  branchName: string;
  conflicts: Array<{ kind: "path" | "branch" | "worktree"; value: string; summary: string }>;
  commands: string[];
  humanAction: string;
}

export type ExecProbe = (cmd: string, args: string[], options?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }>;

export interface AgentWorkspacePlanOptions {
  repoPath?: string;
  exec?: ExecProbe;
}

function normalizeMaybe(path?: string): string | undefined {
  if (!path) return undefined;
  return normalize(resolve(path));
}

function compactTask(task: BacklogItem): Pick<BacklogItem, "id" | "title" | "status"> {
  return { id: task.id, title: task.title, status: task.status };
}

function roleLooksImplementation(agent: Pick<AgentInfo, "role" | "roleName">): boolean {
  const value = `${agent.roleName || ""} ${agent.role || ""}`.toLowerCase();
  return /developer|implement|engineer|reviewer|devops/.test(value);
}

function roleLooksLead(agent: Pick<AgentInfo, "role" | "roleName">): boolean {
  const value = `${agent.roleName || ""} ${agent.role || ""}`.toLowerCase();
  return /lead|architect|planner|coordinator/.test(value);
}

export function isImplementationAgent(agent: Pick<AgentInfo, "role" | "roleName">): boolean {
  return roleLooksImplementation(agent) && !roleLooksLead(agent);
}

export async function resolveAgentRef(session: string, ref: string): Promise<AgentInfo> {
  const byId = await findById(session, ref);
  if (byId) return byId;
  const byName = await findByName(session, ref);
  if (byName) return byName;
  throw new Error(`Agent "${ref}" not found in session "${session}".`);
}

export async function validateAgentTopologyUpdate(session: string, updates: AgentTopologyUpdate): Promise<void> {
  if (updates.roleName) {
    const roles = await readRoles(session);
    if (!roles[updates.roleName]) throw new Error(`Role "${updates.roleName}" not found in session "${session}".`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && typeof value === "string" && value.trim() === "") {
      throw new Error(`${key} cannot be empty.`);
    }
  }
}

export async function updateAgentTopology(
  session: string,
  agentRef: string,
  updates: AgentTopologyUpdate,
): Promise<AgentInfo> {
  const clean = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as AgentTopologyUpdate;
  await validateAgentTopologyUpdate(session, clean);
  const agent = await resolveAgentRef(session, agentRef);
  await updateAgent(session, agent.id, clean);
  return resolveAgentRef(session, agent.id);
}

export async function getTeamTopology(session: string): Promise<TeamTopologyView> {
  const [registry, roles, config, backlog] = await Promise.all([
    readRegistry(session),
    readRoles(session),
    readSessionConfig(session),
    readBacklog(session),
  ]);
  const agents = Object.values(registry).map((agent) => {
    const mine = backlog.filter((task) => task.assigneeId === agent.id);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      roleName: agent.roleName,
      model: agent.model,
      cwd: agent.cwd,
      workspace: agent.workspace,
      status: agent.status,
      availability: agent.availability,
      statusMessage: agent.statusMessage,
      effectivelyOnline: isEffectivelyOnline(agent),
      lastHeartbeat: agent.lastHeartbeat,
      work: {
        active: mine.filter((t) => t.status === "in-progress").map(compactTask),
        assigned: mine.filter((t) => t.status === "assigned").map(compactTask),
        review: mine.filter((t) => t.status === "review").map(compactTask),
        blocked: mine.filter((t) => t.status === "blocked").map(compactTask),
      },
    } satisfies AgentTopologyView;
  });
  return { session, mainRepo: config.mainRepo, agents, roles };
}

function groupByPath(agents: AgentTopologyView[], selector: (agent: AgentTopologyView) => string | undefined): Map<string, AgentTopologyView[]> {
  const groups = new Map<string, AgentTopologyView[]>();
  for (const agent of agents) {
    const path = normalizeMaybe(selector(agent));
    if (!path) continue;
    const group = groups.get(path) || [];
    group.push(agent);
    groups.set(path, group);
  }
  return groups;
}

export async function detectTeamTopologyRisks(session: string): Promise<TeamTopologyRisk[]> {
  const topology = await getTeamTopology(session);
  const risks: TeamTopologyRisk[] = [];

  for (const [path, agents] of groupByPath(topology.agents.filter((a) => a.effectivelyOnline), (a) => a.cwd)) {
    if (agents.length > 1) {
      risks.push({
        kind: "shared-cwd",
        severity: "high",
        path,
        agentIds: agents.map((a) => a.id),
        summary: `Multiple online agents share cwd ${path}: ${agents.map((a) => a.name).join(", ")}.`,
      });
    }
  }

  for (const [path, agents] of groupByPath(topology.agents, (a) => a.workspace)) {
    if (agents.length > 1) {
      risks.push({
        kind: "shared-workspace",
        severity: "medium",
        path,
        agentIds: agents.map((a) => a.id),
        summary: `Multiple agents intend to use workspace ${path}: ${agents.map((a) => a.name).join(", ")}.`,
      });
    }
  }

  const mainRepo = normalizeMaybe(topology.mainRepo);
  for (const agent of topology.agents) {
    if (isImplementationAgent(agent) && !agent.workspace) {
      risks.push({
        kind: "missing-workspace",
        severity: agent.effectivelyOnline ? "medium" : "low",
        agentIds: [agent.id],
        summary: `${agent.name} looks like an implementation agent but has no dedicated workspace recorded.`,
      });
    }
    if (mainRepo && isImplementationAgent(agent)) {
      const cwd = normalizeMaybe(agent.cwd);
      const workspace = normalizeMaybe(agent.workspace);
      if (cwd === mainRepo || workspace === mainRepo) {
        risks.push({
          kind: "implementation-in-main-worktree",
          severity: "high",
          path: mainRepo,
          agentIds: [agent.id],
          summary: `${agent.name} appears to be using the main/integration worktree ${mainRepo}.`,
        });
      }
    }
  }

  const registry = await readRegistry(session);
  const reservations = await getReservations(session);
  for (const [path, reservation] of Object.entries(reservations)) {
    const owner = registry[reservation.agentId];
    if (!owner || !isEffectivelyOnline(owner)) {
      risks.push({
        kind: "stale-reservation",
        severity: "medium",
        agentIds: [reservation.agentId],
        reservationPath: path,
        taskId: reservationTaskId(reservation) || undefined,
        summary: `Reservation ${path} is owned by stale/offline agent ${reservation.agent}.`,
      });
    }
  }

  return risks;
}

export function planWorkspace(options: WorkspacePlanOptions): WorkspacePlan {
  const plan = deriveWorktreePath(options.repoPath, options.agentName);
  const wsPath = normalizeMaybe(plan.wsPath)!;
  const branchName = plan.branchName;
  const conflicts: WorkspacePlan["conflicts"] = [];
  const existingPaths = new Set((options.existingPaths || []).map((p) => normalizeMaybe(p)));
  const existingWorktrees = new Set((options.existingWorktreePaths || []).map((p) => normalizeMaybe(p)));
  const existingBranches = new Set(options.existingBranches || []);
  if (existingPaths.has(wsPath)) conflicts.push({ kind: "path", value: wsPath, summary: `Workspace path already in use: ${wsPath}` });
  if (existingWorktrees.has(wsPath)) conflicts.push({ kind: "worktree", value: wsPath, summary: `Git worktree already exists at ${wsPath}` });
  if (existingBranches.has(branchName)) conflicts.push({ kind: "branch", value: branchName, summary: `Branch already exists: ${branchName}` });
  const commands = [`git -C ${JSON.stringify(options.repoPath)} worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(wsPath)}`];
  return {
    agentName: options.agentName,
    repoPath: options.repoPath,
    wsPath,
    branchName,
    conflicts,
    commands,
    humanAction: workspaceHumanActionText(options.agentName, wsPath),
  };
}

async function probeLines(exec: ExecProbe | undefined, cmd: string, args: string[]): Promise<string[]> {
  if (!exec) return [];
  try {
    const result = await exec(cmd, args, { timeout: 5000 });
    if (result.code !== 0) return [];
    return (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function planAgentWorkspace(
  session: string,
  agentRef: string,
  options: AgentWorkspacePlanOptions = {},
): Promise<WorkspacePlan> {
  const [agent, registry, config] = await Promise.all([
    resolveAgentRef(session, agentRef),
    readRegistry(session),
    readSessionConfig(session),
  ]);
  const repoPath = options.repoPath || config.mainRepo;
  if (!repoPath) throw new Error("Repo path is required for workspace planning (pass repoPath or set session mainRepo).");

  const worktreeLines = await probeLines(options.exec, "git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const existingWorktreePaths = worktreeLines.filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  const branchLines = await probeLines(options.exec, "git", ["-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);

  return planWorkspace({
    repoPath,
    agentName: agent.name,
    existingPaths: Object.values(registry).flatMap((a) => [a.cwd, a.workspace].filter((p): p is string => !!p)),
    existingBranches: branchLines,
    existingWorktreePaths,
  });
}

export function workspaceHumanActionText(agentName: string, workspacePath: string, session?: string): string {
  const join = session ? `, then /amutix join ${session} as ${agentName}` : `, then /amutix join as ${agentName}`;
  return `Please open a new terminal, cd ${workspacePath}, start Pi${join}.`;
}

export function workspaceAssignmentNotice(agent: AgentInfo, workspacePath: string, session: string): string {
  const online = isEffectivelyOnline(agent);
  const mismatch = normalizeMaybe(agent.cwd) !== normalizeMaybe(workspacePath);
  if (online && mismatch) {
    return `${agent.name} is online in ${agent.cwd}. Registry workspace can be updated to ${workspacePath}, but the live process must restart or cd there and rejoin. ${workspaceHumanActionText(agent.name, workspacePath, session)}`;
  }
  return `${agent.name} workspace intent can be set to ${workspacePath}. ${workspaceHumanActionText(agent.name, workspacePath, session)}`;
}
