/**
 * amux  -- Pi Multi-Agent Coordination
 *
 * Terminal-agnostic multi-agent coordination for Pi.
 * Communication uses file-based inboxes.
 *
 * Agent lifecycle:
 *   /amux join       -- join or create a project, pick or create an agent
 *   session shutdown  -- agent goes offline (persists for later)
 *
 * Tools: amux_role, amux_list, amux_send, amux_broadcast,
 *         amux_reserve, amux_project, amux_task, amux_journal
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import {
  getSessionsDir,
  sessionDir,
  sessionFile,
  listSessions,
} from "../core/storage";
import { BUILTIN_ROLES } from "../core/index";
import {
  type AgentInfo,
  type RoleDefinition,
  readRegistry,
  readAllRegistries,
  registerAgent,
  updateAgent,
  updateHeartbeat,
  goOnline,
  goOffline,
  newAgentId,
  findByName,
  findById,
  getOnlineAgents,
  getOfflineAgents,
  isEffectivelyOnline,
  shouldSignalAgent,
  HEARTBEAT_INTERVAL_MS,
  resolveAgent,
  parseAddress,
  formatAddress,
  readRoles,
  getRole,
  addRole,
  removeRole,
  readSessionConfig,
  writeSessionConfig,
} from "../core/registry";
import {
  resolveRoleInstructions,
  listRoleTemplates,
  listTeamTemplates,
  getTeamTemplate,
  applyTeamTemplate,
  readRoleTemplate,
  roleProfileFullPath,
} from "../core/roles";
import {
  assembleAgentPrompt,
  COMMON_PRINCIPLES,
  formatPromptPreview,
  formatPromptSectionPreview,
  formatPromptSummary,
  PROMPT_SECTION_ORDER,
  type PromptSections,
} from "../core/prompt-assembly";
import {
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  watchInbox,
  newMessageId,
  formatMessageAge,
  type InboxMessage,
} from "../core/messaging";
import {
  reserve,
  release,
  getReservations,
  checkConflict,
  clearStaleReservations,
  toWorkspaceRelative,
  formatReservationAge,
  formatReservationConflict,
  reservationTaskId,
} from "../core/reservations";
import {
  type BacklogItem,
  readBacklog,
  addTask,
  getTask,
  readSpecPreview,
  planTaskSpec,
  archiveDoneTasks,
} from "../core/backlog";
import {
  appendEntry as addJournalEntry,
  readEntries as readJournalEntries,
  getRecentEntries,
  formatEntry as formatJournalEntry,
} from "../core/journal";
import {
  appendTaskComment,
  readTaskComments,
  formatTaskComment,
  resolveTaskCommentSubscribers,
  taskCommentPreview,
  type TaskComment,
} from "../core/task-comments";
import {
  projectContextPath,
  readProjectContext,
  writeProjectContext,
  appendProjectContext,
  clearProjectContext,
} from "../core/project-context";
import {
  readWaysOfWorking,
  writeWaysOfWorking,
  appendWaysOfWorking,
  clearWaysOfWorking,
  ensureDefaultWaysOfWorking,
  wowPath,
} from "../core/ways-of-working";
import {
  renderTaskListRow,
  renderTaskDetails,
  renderProgressSummary,
  renderAgentPresence,
  renderAgentWorkState,
} from "../core/renderers";
import {
  serviceAssignTasks,
  servicePickTask,
  serviceCompleteTask,
  serviceReviewTask,
  serviceDropTask,
  serviceBlockTask,
  serviceGetTaskShowData,
} from "../core/task-service";



export default function (pi: ExtensionAPI) {
  // -- State ----------------------------------------------------
  let myId: string | undefined; // UUID  -- stable across restarts
  let myName: string | undefined;
  let myRole: string | undefined;
  let myRoleName: string | undefined;
  let myRoleInstructions: string | undefined;
  let mySession: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let inboxWatcher: FSWatcher | undefined;
  let currentModelStr: string | undefined;
  let currentCtx: ExtensionContext | undefined;

  function myAddress(): string {
    return formatAddress(mySession!, myName!);
  }

  function myPrefix(): string {
    const addr = myAddress();
    return myRoleName ? `[amux:${addr} (${myRoleName})]` : `[amux:${addr}]`;
  }

  function inboxMessagePrefix(msg: InboxMessage): string {
    const age = formatMessageAge(msg.timestamp);
    const catStr = msg.category ? ` · ${msg.category}` : "";
    const taskStr = msg.taskId ? ` · ${msg.taskId}` : "";
    return msg.fromRole
      ? `[amux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})${catStr}${taskStr} · sent ${age}]`
      : `[amux:${msg.fromSession}/${msg.fromName}${catStr}${taskStr} · sent ${age}]`;
  }

  /** Check if a role name matches a built-in role template. */
  function isBuiltinRole(name: string): boolean {
    return BUILTIN_ROLES.some((r) => r.name === name);
  }

  /** Get all agents (any status) that reference a given role. */
  async function getRoleUsage(session: string, roleName: string): Promise<AgentInfo[]> {
    const registry = await readRegistry(session);
    return Object.values(registry).filter((a) => a.roleName === roleName);
  }

  // -- Agent Startup/Shutdown Helpers ---------------------------

  /** Common setup after register or login. */
  async function startAgent(ctx: ExtensionContext): Promise<void> {
    if (!myId || !mySession || !myName) return;

    // Mark online
    await goOnline(mySession, myId, process.pid);

    // Ensure inbox and artifact directories exist
    ensureInbox(mySession, myId);
    ensureArtifactDirs();

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (mySession && myId) {
        await updateHeartbeat(mySession, myId).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Start inbox watcher  -- deliver messages via pi.sendUserMessage
    if (inboxWatcher) inboxWatcher.close();
    inboxWatcher = watchInbox(mySession, myId, (msg, filename) => {
      // Crash-safe: history first, then mark delivered, then queue
      appendToHistory(mySession!, msg);
      markAsDelivered(mySession!, myId!, filename);

      pi.sendUserMessage(`${inboxMessagePrefix(msg)} ${msg.message}`, {
        deliverAs: "followUp",
      });
    });

    // Deliver pending + crash-recovery messages
    const recoverable = getRecoverableMessages(mySession, myId);
    for (const { msg, filename } of recoverable) {
      // Only append to history for new messages (not already-delivered ones)
      if (filename.endsWith(".json")) {
        appendToHistory(mySession, msg);
        markAsDelivered(mySession, myId, filename);
      }

      pi.sendUserMessage(`${inboxMessagePrefix(msg)} ${msg.message}`, {
        deliverAs: "followUp",
      });
    }

    // Persist UUID in pi session (survives /reload)
    pi.appendEntry("amux-agent", { id: myId, session: mySession });

    // Update titles and status widget
    updateTitles(ctx);
    await refreshStatusWidget(ctx);
  }

  /** Cleanup on shutdown. */
  function stopAgent(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (inboxWatcher) {
      inboxWatcher.close();
      inboxWatcher = undefined;
    }
  }

  function updateTitles(ctx: ExtensionContext): void {
    const name = myName ?? "pi";
    const title = myRoleName ? `${name} (${myRoleName})` : name;
    ctx.ui.setTitle(title);
  }

  /** Load role instructions from roles.json. */
  async function loadRoleInstructions(session: string, roleName: string): Promise<boolean> {
    const role = await getRole(session, roleName);
    if (!role) return false;
    myRoleName = role.name;
    myRole = role.name;
    myRoleInstructions = resolveRoleInstructions(session, role);
    return true;
  }

  // -- Lifecycle ------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Reload recovery: check pi session entries for stored agent
    let recoveredId: string | undefined;
    let recoveredSession: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "amux-agent") {
        const data = entry.data as { id: string; session: string };
        recoveredId = data.id;
        recoveredSession = data.session;
      }
    }

    if (recoveredId && recoveredSession) {
      const agent = await findById(recoveredSession, recoveredId);
      if (agent) {
        mySession = recoveredSession;
        myId = agent.id;
        myName = agent.name;
        myRole = agent.role;
        if (agent.roleName) {
          await loadRoleInstructions(mySession, agent.roleName);
        }
        await startAgent(ctx);

        // Restore saved model preference on recovery
        if (agent.model) {
          await trySetModel(ctx, agent.model);
        }
        return;
      }
    }

    // Otherwise: silent. Use /amux join to get started.
  });

  pi.on("session_shutdown", async (event) => {
    stopAgent();

    // Mark offline (unless reloading  -- keep online for recovery)
    if (event.reason !== "reload" && mySession && myId) {
      await goOffline(mySession, myId).catch(() => {});
    }

    currentCtx = undefined;
  });

  // -- Agent Status Tracking ------------------------------------

  pi.on("agent_start", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
    }
  });

  pi.on("agent_end", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
      // Clean up .delivered files  -- messages confirmed processed
      confirmDelivered(mySession, myId);
      // Clean up stale reservations (held by offline agents)
      const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
      const onlineIds = online.map((a) => a.id);
      await clearStaleReservations(mySession, onlineIds).catch(() => {});
    }
    if (currentCtx) {
      await refreshStatusWidget(currentCtx);
    }
  });

  // -- File Reservation Warnings --------------------------------

  pi.on("tool_result", async (event) => {
    if (!mySession || !myId) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = (event.input as Record<string, unknown>).path as string | undefined;
    if (!filePath) return;

    // Normalize absolute paths relative to the working directory
    // so they match relative reservations consistently
    const normalizedPath = toWorkspaceRelative(filePath, process.cwd());

    // Get online agent IDs for stale detection
    const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
    const onlineIds = online.map((a) => a.id);

    const conflict = await checkConflict(mySession, normalizedPath, myId, onlineIds);
    if (!conflict) return;

    const { reservedPath, reservation, stale } = conflict;
    const taskId = reservationTaskId(reservation);
    const owner = await findById(mySession, reservation.agentId);
    const backlog = await readBacklog(mySession);
    const ownerWork = renderAgentWorkState(reservation.agentId, backlog);
    const ownerState = owner
      ? [owner.availability, ownerWork].filter(Boolean).join(", ")
      : ownerWork;
    const ownerNote = ownerState ? ` Owner state: ${ownerState}.` : "";
    const guidance = taskId
      ? `Use amux_task comment on ${taskId} to coordinate.`
      : `Use amux_send('${reservation.agent}', ...) only for exceptional coordination.`;
    const warning =
      `⚠️ ${filePath} conflicts with reservation ${formatReservationConflict(reservedPath, reservation, stale)}` +
      `${ownerNote} ${guidance}`;

    // Prepend warning to result content
    return {
      content: [
        { type: "text" as const, text: warning },
        ...event.content,
      ],
    };
  });


  // -- Auto-save model preference --

  pi.on("model_select", async (event) => {
    if (!event.model) return;
    const modelId = `${event.model.provider}/${event.model.id}`;
    currentModelStr = modelId;

    // Auto-save to agent record (skip "restore" -- that's not a user choice)
    if (event.source !== "restore" && mySession && myId) {
      await updateAgent(mySession, myId, { model: modelId }).catch(() => {});
    }
  });

  // -- System Prompt Injection ----------------------------------

  pi.on("before_agent_start", async (event) => {
    if (!mySession || !myName) return;

    // Clear attention pending flag on agent interaction
    if (myId) {
      const self = await findById(mySession, myId);
      if (self?.attentionPending) {
        await updateAgent(mySession, myId, { attentionPending: false });
      }
    }

    if (!myId) return;

    const sections = await gatherPromptSections();
    const assembled = assembleAgentPrompt(sections);

    if (!assembled) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + assembled };
  });

  /**
   * Gather all amux coordination sections for the joined agent, in the
   * deliberate order. This is the SINGLE gathering path used by both the
   * before_agent_start hook (where this adapter appends the assembled block
   * to the host runtime's base prompt) and the `/amux prompt` debug/preview command -- so the
   * injected prompt and the previewed prompt can never drift.
   *
   * Caller must ensure the agent has joined (mySession/myId/myName set).
   */
  async function gatherPromptSections(): Promise<PromptSections> {
    const session = mySession!, id = myId!, name = myName!;
    const backlog = await readBacklog(session);

    // ── Section 2: Ways of Working (extends common principles) ──
    const wowContent = readWaysOfWorking(session);
    const waysOfWorking = wowContent ? `## Ways of Working\n${wowContent}` : "";

    // ── Section 3: Project vision/context ──
    const projectCtx = readProjectContext(session);
    const projectContext = projectCtx ? `## Project Context\n${projectCtx}` : "";

    // ── Section 3: Role profile (role-specific only) ──
    const roleProfile = myRoleInstructions ? `## Your Role: ${myRoleName}\n${myRoleInstructions}` : "";

    // ── Section 4: Agent identity + workspace ──
    let identity = `## Your Identity & Workspace\nYou are agent "${name}" in session "${session}" (full address: ${myAddress()}).`;
    if (myRoleName) identity += `\nRole: ${myRoleName}.`;
    {
      const agent = await findById(session, id);
      if (agent?.workspace) {
        const branchResult = await pi.exec("git", ["-C", agent.workspace, "branch", "--show-current"], { timeout: 5000 });
        const branch = branchResult.stdout?.trim() || "unknown";
        identity += `\nWorkspace: ${agent.workspace} (branch: ${branch}). Use this as your working directory for all file operations.`;
      }
    }

    // ── Section 5: Current work state (active/review/assigned, spec, recent comments) ──
    let workState = "";
    {
      const inProgress = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === id);
      const review = backlog.filter((t) => t.status === "review" && t.assigneeId === id);
      const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === id);

      if (inProgress.length > 0) {
        const active = inProgress[0]!;
        workState += `## Active Task\n${active.id}: ${active.title}`;
        if (active.parentId) {
          const parent = backlog.find((t) => t.id === active.parentId);
          if (parent) workState += `\nParent: ${parent.id}: ${parent.title}`;
        }
        if (active.files?.length) workState += `\nFiles: ${active.files.join(", ")}`;
        if (active.specPath) {
          const spec = readSpecPreview(session, active.specPath, 2000);
          if (spec) workState += `\n\n${spec}`;
        }
        const comments = readTaskComments(session, active.id);
        if (comments.length > 0) {
          const recent = comments.slice(-3);
          workState += `\nRecent activity:\n${recent.map((c) => `- ${formatTaskComment(c)}`).join("\n")}`;
        }
      }

      if (review.length > 0) {
        const ids = review.map((t) => `${t.id}: ${t.title}`).join("\n  ");
        workState += `${workState ? "\n\n" : ""}## Ready for Review (${review.length})\n  ${ids}\n\nThese are implemented and waiting for review/integration. Use amux_task comment for review discussion.`;
      }

      if (assigned.length > 0) {
        const ids = assigned.map((t) => `${t.id}: ${t.title}`).join("\n  ");
        workState += `${workState ? "\n\n" : ""}## Assigned Tasks (${assigned.length})\n  ${ids}\n\nUse amux_task show <id> for details, or amux_task pick <id> to start working.`;
      }
    }

    // ── Section 6: Team / project snapshot / journal context ──
    let teamContext = "";
    {
      const registry = await readRegistry(session);
      const projectAgents = Object.values(registry).filter((a) => a.id !== id);
      const allAgents = await readAllRegistries();
      const crossSessionAgents = allAgents.filter(
        (a) => a.session !== session && isEffectivelyOnline(a)
      );

      if (projectAgents.length > 0 || crossSessionAgents.length > 0) {
        teamContext += `## Team`;
        if (projectAgents.length > 0) {
          const list = projectAgents.map((a) => renderAgentPresence(a, backlog)).join("\n");
          teamContext += `\n\nSame-session agents (address as "${session}/<name>" or just "<name>"):\n${list}`;
        }
        if (crossSessionAgents.length > 0) {
          const backlogBySession = new Map<string, BacklogItem[]>();
          const lines: string[] = [];
          for (const agent of crossSessionAgents) {
            if (!backlogBySession.has(agent.session)) {
              backlogBySession.set(agent.session, await readBacklog(agent.session));
            }
            lines.push(renderAgentPresence(agent, backlogBySession.get(agent.session)!, {
              address: formatAddress(agent.session, agent.name),
            }));
          }
          teamContext += `\nCross-session agents (must use full address "session/name"):\n${lines.join("\n")}`;
        }
        teamContext += `\n\n### Addressing\n- Same-session agents: use just the name (e.g., "backend") or full address ("${session}/backend")\n- Cross-session agents: always use the full address ("othersession/agentname")`;
      }

      const activeStatuses = ["todo", "assigned", "in-progress", "review", "blocked"];
      const counts = new Map(activeStatuses.map((status) => [status, 0]));
      for (const item of backlog) {
        if (counts.has(item.status)) counts.set(item.status, (counts.get(item.status) || 0) + 1);
      }
      const openCount = activeStatuses.reduce((sum, status) => sum + (counts.get(status) || 0), 0);
      const ready = backlog.filter((t) => t.status === "review").slice(0, 3);
      const blocked = backlog.filter((t) => t.status === "blocked").slice(0, 3);
      const reservations = await getReservations(session);
      const reservationLines = Object.entries(reservations).slice(0, 5).map(([path, r]) => {
        const reason = r.reason ? ` (${r.reason.length > 70 ? `${r.reason.slice(0, 67)}…` : r.reason})` : "";
        return `- ${path}: ${r.agent}, ${formatReservationAge(r.since)}${reason}`;
      });

      if (openCount > 0 || reservationLines.length > 0) {
        const countStr = activeStatuses
          .map((status) => `${status} ${counts.get(status) || 0}`)
          .join(", ");
        let snapshot = `## Project Snapshot\nOpen work: ${openCount} (${countStr})`;
        if (ready.length > 0) {
          snapshot += `\nReady for review: ${ready.map((t) => `${t.id}: ${t.title}${t.assignee ? ` — ${t.assignee}` : ""}`).join("; ")}`;
        }
        if (blocked.length > 0) {
          snapshot += `\nBlocked: ${blocked.map((t) => `${t.id}: ${t.title}${t.blockedReason ? ` (${t.blockedReason})` : ""}`).join("; ")}`;
        }
        if (reservationLines.length > 0) {
          snapshot += `\nActive reservations:\n${reservationLines.join("\n")}`;
        }
        teamContext += `${teamContext ? "\n\n" : ""}${snapshot}`;
      }

      const recentJournal = getRecentEntries(session);
      if (recentJournal.length > 0) {
        const journalLines = recentJournal.map((e) => `- ${formatJournalEntry(e)}`);
        teamContext += `${teamContext ? "\n\n" : ""}## Recent Journal\n${journalLines.join("\n")}`;
      }
    }

    // ── Section 7: Interface/tool guidance + shared artifact paths ──
    const interfaceGuidance = `## Interfaces & Artifacts
- Messages from other agents appear as "[amux:session/agent (role) \u00b7 sent Xm ago] message". Treat them as teammate requests; reply with amux_send to the sender.
- Use amux_project to set or update project vision/context; do not edit CONTEXT.md directly unless the interface is unavailable.
- Task details are state-derived: assigned work appears in your work state and backlog, not as inbox messages.

### Shared Artifacts
Read and write shared documents using the standard read/write/edit tools.
- Project (all agents): ${projectArtifactsDir()}
- Private (you only): ${agentArtifactsDir(id)}`;

    return {
      commonPrinciples: COMMON_PRINCIPLES,
      waysOfWorking,
      projectContext,
      roleProfile,
      identity,
      workState,
      teamContext,
      interfaceGuidance,
    };
  }

  // -- Tools ----------------------------------------------------

  // - amux_role -------------------------------------------------

  pi.registerTool({
    name: "amux_role",
    label: "Manage Roles",
    description:
      "Add, list, remove, or apply role definitions for the current amux session. " +
      "Roles define a name and instructions that shape an agent's behavior. " +
      "Use templates/apply-template for bundled role profiles and team setups. " +
      "Agents join projects with /amux join.",
    promptSnippet: "Manage amux roles  -- add, list, remove, templates, apply-template, show, path",
    promptGuidelines: [
      "Use amux_role apply-template to quickly set up a standard team (e.g. core-team).",
      "Use amux_role templates to see bundled role profiles and team templates.",
      "Applying a team template copies role profiles and registers roles  -- it does not create agents.",
      "Each amux_role has a name and instructions that guide the agent's behavior.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "remove", "templates", "apply-template", "show", "path"] as const),
      name: Type.Optional(
        Type.String({ description: 'Role name (required for "add", "remove", "show", "path")' })
      ),
      instructions: Type.Optional(
        Type.String({
          description:
            'Instructions for the role  -- what the agent should do, focus on, and how to behave (required for "add")',
        })
      ),
      template: Type.Optional(
        Type.String({ description: 'Team template name (required for "apply-template", e.g. "core-team")' })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        case "add": {
          if (!params.name) throw new Error("Role name is required for add.");
          if (!params.instructions) throw new Error("Instructions are required for add.");
          await addRole(mySession, { name: params.name, instructions: params.instructions });
          return {
            content: [{ type: "text", text: `Role "${params.name}" added. Agents can join with: /amux join` }],
            details: { role: { name: params.name, instructions: params.instructions } },
          };
        }
        case "list": {
          const roles = await readRoles(mySession);
          const entries = Object.values(roles);
          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No roles defined. Use amux_role with action=add to create one." }],
              details: { roles: [] },
            };
          }
          const registry = await readRegistry(mySession);
          const allAgents = Object.values(registry);
          const lines = entries.map((r) => {
            const usedBy = allAgents.filter((a) => a.roleName === r.name).map((a) => a.name);
            const builtinTag = isBuiltinRole(r.name) ? "built-in" : "custom";
            const usageTag = usedBy.length > 0 ? `used by: ${usedBy.join(", ")}` : "unused";
            const truncInstr = r.instructions.slice(0, 100) + (r.instructions.length > 100 ? "…" : "");
            return `- ${r.name} [${builtinTag}, ${usageTag}]: ${truncInstr}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }], details: { roles: entries } };
        }
        case "remove": {
          if (!params.name) throw new Error("Role name is required for remove.");

          // Rule 1: Built-in roles can't be deleted
          if (isBuiltinRole(params.name)) {
            throw new Error(
              `Role "${params.name}" is a built-in role and cannot be deleted. ` +
              `Use action "add" to customize its instructions instead.`
            );
          }

          // Rule 2: Can't delete roles in use by agents
          const usedBy = await getRoleUsage(mySession, params.name);
          if (usedBy.length > 0) {
            const names = usedBy.map((a) => a.name).join(", ");
            throw new Error(
              `Role "${params.name}" is used by ${names}. Reassign them first.`
            );
          }

          const removed = await removeRole(mySession, params.name);
          if (!removed) throw new Error(`Role "${params.name}" not found.`);
          return { content: [{ type: "text", text: `Role "${params.name}" removed.` }], details: {} };
        }
        case "templates": {
          const roleTemplates = listRoleTemplates();
          const teamTemplates = listTeamTemplates();
          let text = "Bundled role profiles:\n";
          text += roleTemplates.map((t) => `  - ${t}`).join("\n") || "  (none)";
          text += "\n\nTeam templates:\n";
          text += teamTemplates
            .map((t) => `  - ${t.name}: ${t.description} [${t.roles.map((r) => r.name).join(", ")}]`)
            .join("\n") || "  (none)";
          text += "\n\nApply a team: amux_role apply-template <name>";
          return { content: [{ type: "text", text }], details: { roleTemplates, teamTemplates } };
        }
        case "apply-template": {
          if (!params.template) throw new Error("Template name is required for apply-template.");
          const result = await applyTeamTemplate(mySession, params.template);
          if (!result) {
            const available = listTeamTemplates().map((t) => t.name).join(", ");
            throw new Error(`Team template "${params.template}" not found. Available: ${available || "none"}`);
          }
          const agentHints = result.template.roles
            .filter((r) => r.agentName)
            .map((r) => `  ${r.name} \u2192 suggested agent "${r.agentName}" (workspace: ${r.workspace || "none"})`)
            .join("\n");
          let text = `Applied team template "${result.template.name}".\nRoles registered: ${result.applied.join(", ")}.`;
          if (agentHints) {
            text += `\n\nSuggested agents (create separately via /amux new agent):\n${agentHints}`;
          }
          return { content: [{ type: "text", text }], details: result };
        }
        case "show": {
          if (!params.name) throw new Error("Role name is required for show.");
          const role = await getRole(mySession, params.name);
          if (!role) throw new Error(`Role "${params.name}" not found.`);
          const resolved = resolveRoleInstructions(mySession, role);
          let text = `# ${role.name}`;
          if (role.profilePath) text += `\nProfile: ${role.profilePath}`;
          if (role.templateName) text += `\nTemplate: ${role.templateName}`;
          text += `\n\n${resolved}`;
          return { content: [{ type: "text", text }], details: { role } };
        }
        case "path": {
          if (!params.name) throw new Error("Role name is required for path.");
          const role = await getRole(mySession, params.name);
          if (!role) throw new Error(`Role "${params.name}" not found.`);
          if (!role.profilePath) {
            return {
              content: [{ type: "text", text: `Role "${params.name}" uses inline instructions and has no profile file.` }],
              details: { role },
            };
          }
          const fullPath = roleProfileFullPath(mySession, role.profilePath);
          return { content: [{ type: "text", text: fullPath }], details: { path: fullPath, profilePath: role.profilePath } };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - amux_list -------------------------------------------------

  pi.registerTool({
    name: "amux_list",
    label: "List Agents",
    description:
      "List online amux agents with their session, name, role, and status. " +
      "Set allSessions=true to include agents from other sessions.",
    promptSnippet: "List online amux agents and their roles/status (supports cross-session discovery)",
    parameters: Type.Object({
      allSessions: Type.Optional(
        Type.Boolean({ description: "If true, list agents from all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter(isEffectivelyOnline);
      } else {
        agents = await getOnlineAgents(mySession);
      }

      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents online." }], details: { agents: [] } };
      }

      // Group by session
      const bySession = new Map<string, AgentInfo[]>();
      for (const a of agents) {
        const sess = a.session || mySession;
        if (!bySession.has(sess)) bySession.set(sess, []);
        bySession.get(sess)!.push(a);
      }

      const sections: string[] = [];
      const backlogBySession = new Map<string, BacklogItem[]>();
      for (const [session, sessionAgents] of bySession) {
        const isCurrent = session === mySession;
        const header = isCurrent ? `Session: ${session} (current)` : `Session: ${session}`;
        if (!backlogBySession.has(session)) {
          backlogBySession.set(session, await readBacklog(session));
        }
        const backlog = backlogBySession.get(session)!;
        const lines = sessionAgents.map((a) =>
          renderAgentPresence(a, backlog, {
            currentAgentId: myId,
            address: formatAddress(session, a.name),
            includeCwd: true,
          })
        );
        sections.push(`${header}\n${lines.join("\n")}`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n") }], details: { agents } };
    },
  });

  // - amux_send -------------------------------------------------

  pi.registerTool({
    name: "amux_send",
    label: "Send to Agent",
    description:
      'Send a message to another amux agent. Use "name" for same-session or "session/name" for cross-session. ' +
      "Delivered to the agent's inbox  -- works even if they're busy or offline. " +
      "For task-related discussion, prefer amux_task comment instead.",
    promptSnippet: "Send a message to a amux agent by name or session/name address",
    promptGuidelines: [
      "Use amux_send only for exceptional general communication not tied to a backlog item.",
      "For task-related discussion, use amux_task comment instead  -- comments stay on the task.",
      'For cross-session agents, use the full address in amux_send: "session/name".',
      "After using amux_send, do not wait  -- continue with your own work unless you need their response first.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: '"name" for same session, or "session/name" for cross-session' }),
      message: Type.String({ description: "Message or instruction to send" }),
      category: Type.Optional(
        StringEnum(["urgent", "fyi", "brainstorm"] as const, {
          description: "Message intent. Use urgent sparingly; prefer task comments for task-related discussion.",
        })
      ),
      taskId: Type.Optional(Type.String({ description: "Optional related task ID for context/staleness assessment" })),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
      }

      const target = await resolveAgent(params.to, mySession);
      if (!target) {
        const all = await readAllRegistries();
        const online = all.filter((a) => isEffectivelyOnline(a) && a.id !== myId);
        const available = online.map((a) => formatAddress(a.session, a.name)).join(", ");
        throw new Error(`Agent "${params.to}" not found. Available: ${available || "none"}`);
      }

      if (target.id === myId) throw new Error("Cannot send a message to yourself.");

      const msg: InboxMessage = {
        id: newMessageId(),
        from: myId,
        fromName: myName,
        fromRole: myRoleName,
        fromSession: mySession,
        timestamp: new Date().toISOString(),
        message: params.message,
        category: params.category,
        taskId: params.taskId,
      };

      sendToInbox(target.session, target.id, msg);

      const targetAddr = formatAddress(target.session, target.name);
      return {
        content: [{ type: "text", text: `Message sent to ${targetAddr} (${target.roleName || target.role}).` }],
        details: { to: targetAddr, targetId: target.id },
      };
    },
  });

  // - amux_broadcast --------------------------------------------

  pi.registerTool({
    name: "amux_broadcast",
    label: "Broadcast",
    description:
      "Send a message to all other online agents. Set allSessions=true for cross-session. " +
      "Use sparingly  -- prefer targeted amux_send.",
    promptSnippet: "Broadcast a message to online amux agents",
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast" }),
      allSessions: Type.Optional(
        Type.Boolean({ description: "Broadcast to all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
      }

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter(isEffectivelyOnline);
      } else {
        agents = await getOnlineAgents(mySession);
      }

      const others = agents.filter((a) => a.id !== myId);
      if (others.length === 0) throw new Error("No other agents online.");

      const errors: string[] = [];
      for (const agent of others) {
        try {
          const msg: InboxMessage = {
            id: newMessageId(),
            from: myId,
            fromName: myName,
            fromRole: myRoleName,
            fromSession: mySession,
            timestamp: new Date().toISOString(),
            message: params.message,
          };
          sendToInbox(agent.session, agent.id, msg);
        } catch (err) {
          errors.push(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const recipients = others.map((a) => formatAddress(a.session, a.name));
      let text = `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}`;
      if (errors.length > 0) text += `\nFailed: ${errors.join("; ")}`;

      return { content: [{ type: "text", text }], details: { recipients, errors } };
    },
  });

  // - amux_artifacts --------------------------------------------

  pi.registerTool({
    name: "amux_artifacts",
    label: "List Artifacts",
    description:
      "List shared documents at project and agent levels. " +
      "Use read/write/edit tools to work with the files directly.",
    promptSnippet: "List shared artifacts at project or agent level",
    parameters: Type.Object({}),

    async execute() {
      if (!mySession || !myId) {
        throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
      }

      const sections: string[] = [];

      // Project level
      const projDir = projectArtifactsDir();
      const projFiles = listFiles(projDir);
      sections.push(`Project (${projDir}):\n` +
        (projFiles.length > 0 ? projFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));


      // Agent level
      const aDir = agentArtifactsDir(myId);
      const aFiles = listFiles(aDir);
      sections.push(`Private (${aDir}):\n` +
        (aFiles.length > 0 ? aFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
      };
    },
  });

  // - amux_project ----------------------------------------------

  pi.registerTool({
    name: "amux_project",
    label: "Project Vision/Context",
    description:
      "Manage the current project's vision/context alignment artifact. " +
      "Actions: show, set, append, clear, path. Stored as artifacts/project/CONTEXT.md " +
      "and injected into future agent prompts.",
    promptSnippet: "Manage project vision/context (show, set, append, clear, path)",
    promptGuidelines: [
      "Use amux_project to set a project vision/context during setup before assigning work.",
      "Prefer amux_project over directly editing CONTEXT.md; the file is an implementation detail.",
      "Keep project context concise: goal, constraints, working principles, and north star.",
    ],
    parameters: Type.Object({
      action: StringEnum(["show", "set", "append", "clear", "path"] as const),
      content: Type.Optional(
        Type.String({ description: "Project vision/context text (required for set and append)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        case "show": {
          const content = readProjectContext(mySession);
          const path = projectContextPath(mySession);
          if (!content) {
            return {
              content: [{ type: "text", text: "No project vision/context set. Use amux_project action=set to create one." }],
              details: { path, content: null },
            };
          }
          return {
            content: [{ type: "text", text: `Project vision/context (${path}):\n\n${content}` }],
            details: { path, content },
          };
        }
        case "set": {
          const text = params.content?.trim();
          if (!text) throw new Error("content is required for action=set");
          const path = writeProjectContext(mySession, text);
          return {
            content: [{ type: "text", text: "Project vision/context set. Changes affect future agent prompts." }],
            details: { path, content: text },
          };
        }
        case "append": {
          const text = params.content?.trim();
          if (!text) throw new Error("content is required for action=append");
          const path = appendProjectContext(mySession, text);
          const content = readProjectContext(mySession, 0);
          return {
            content: [{ type: "text", text: "Appended to project vision/context. Changes affect future agent prompts." }],
            details: { path, content },
          };
        }
        case "clear": {
          const path = clearProjectContext(mySession);
          return {
            content: [{ type: "text", text: "Project vision/context cleared. Changes affect future agent prompts." }],
            details: { path, content: "" },
          };
        }
        case "path": {
          const path = projectContextPath(mySession);
          return { content: [{ type: "text", text: path }], details: { path } };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - amux_wow --------------------------------------------------

  pi.registerTool({
    name: "amux_wow",
    label: "Ways of Working",
    description:
      "Manage the team's Ways of Working artifact. " +
      "Actions: show, set, append, clear, path. Stored as artifacts/project/WOW.md " +
      "and injected into future agent prompts after common principles.",
    promptSnippet: "Manage team Ways of Working (show, set, append, clear, path)",
    promptGuidelines: [
      "Use amux_wow to define team collaboration norms (review policy, communication, definition of done).",
      "WoW extends the built-in common principles with project-specific norms.",
      "Keep WoW concise — it is prompt-injected into every agent turn.",
    ],
    parameters: Type.Object({
      action: StringEnum(["show", "set", "append", "clear", "path"] as const),
      content: Type.Optional(
        Type.String({ description: "WoW text (required for set and append)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        case "show": {
          const content = readWaysOfWorking(mySession);
          const path = wowPath(mySession);
          if (!content) {
            return {
              content: [{ type: "text", text: "No Ways of Working set. Use amux_wow action=set to create one." }],
              details: { path, content: null },
            };
          }
          return {
            content: [{ type: "text", text: `Ways of Working (${path}):\n\n${content}` }],
            details: { path, content },
          };
        }
        case "set": {
          const text = params.content?.trim();
          if (!text) throw new Error("content is required for action=set");
          const path = writeWaysOfWorking(mySession, text);
          return {
            content: [{ type: "text", text: "Ways of Working set. Changes affect future agent prompts." }],
            details: { path, content: text },
          };
        }
        case "append": {
          const text = params.content?.trim();
          if (!text) throw new Error("content is required for action=append");
          const path = appendWaysOfWorking(mySession, text);
          const content = readWaysOfWorking(mySession, 0);
          return {
            content: [{ type: "text", text: "Appended to Ways of Working. Changes affect future agent prompts." }],
            details: { path, content },
          };
        }
        case "clear": {
          const path = clearWaysOfWorking(mySession);
          return {
            content: [{ type: "text", text: "Ways of Working cleared. Changes affect future agent prompts." }],
            details: { path, content: "" },
          };
        }
        case "path": {
          const path = wowPath(mySession);
          return { content: [{ type: "text", text: path }], details: { path } };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - amux_reserve ----------------------------------------------

  pi.registerTool({
    name: "amux_reserve",
    label: "File Reservations",
    description:
      "Manage file/directory reservations to prevent conflicts. " +
      "Actions: claim (reserve paths), release (free paths), list (show all). " +
      "Trailing slash = directory prefix, no slash = exact file.",
    promptSnippet: "Manage file reservations  -- claim, release, list",
    promptGuidelines: [
      "Use amux_reserve with action 'claim' before editing files other agents might work on.",
      "Trailing slash = directory prefix (e.g., 'src/auth/'), no slash = exact file.",
      "Release reservations with action 'release' when done editing.",
    ],
    parameters: Type.Object({
      action: StringEnum(["claim", "release", "list"] as const),
      paths: Type.Optional(
        Type.Array(Type.String({ description: "Paths to claim or release (trailing slash = directory prefix)" }))
      ),
      reason: Type.Optional(
        Type.String({ description: "Why you're claiming these paths (shown to other agents)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        case "claim": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.paths?.length) throw new Error("Paths are required for claim.");

          const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
          const onlineIds = online.map((a) => a.id);

          const reserved = await reserve(mySession, params.paths, myId, myName, params.reason, onlineIds);

          const reasonNote = params.reason ? ` (${params.reason})` : "";
          return {
            content: [{
              type: "text",
              text: `Reserved ${reserved.length} path(s)${reasonNote}:\n${reserved.map((p) => `  ✓ ${p}`).join("\n")}`,
            }],
            details: { reserved, reason: params.reason },
          };
        }

        case "release": {
          if (!myId) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.paths?.length) throw new Error("Paths are required for release.");

          const released = await release(mySession, params.paths, myId);

          if (released.length === 0) {
            return {
              content: [{ type: "text", text: "No matching reservations found to release." }],
              details: { released: [] },
            };
          }
          return {
            content: [{
              type: "text",
              text: `Released ${released.length} reservation(s):\n${released.map((p) => `  ✓ ${p}`).join("\n")}`,
            }],
            details: { released },
          };
        }

        case "list": {
          const reservations = await getReservations(mySession);
          const entries = Object.entries(reservations);

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No active reservations." }],
              details: { reservations: {} },
            };
          }

          const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
          const onlineIds = new Set(online.map((a) => a.id));

          const backlog = await readBacklog(mySession);
          const lines = entries.map(([path, res]) => {
            const duration = formatReservationAge(res.since);
            const reasonStr = res.reason ? `  -- ${res.reason}` : "";
            const taskId = reservationTaskId(res);
            const taskStr = taskId ? ` [${taskId}]` : "";
            const stale = !onlineIds.has(res.agentId);
            const staleStr = stale ? " [stale -- agent offline]" : "";
            const work = renderAgentWorkState(res.agentId, backlog);
            const workStr = work ? ` (${work})` : ` (${duration})`;
            const isMe = res.agentId === myId;
            const marker = isMe ? " (you)" : "";
            return `  ${path}  →  ${res.agent}${marker}${taskStr}${reasonStr}${workStr}${staleStr}`;
          });

          return {
            content: [{ type: "text", text: `Active reservations:\n${lines.join("\n")}` }],
            details: { reservations },
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - amux_task -------------------------------------------------

  pi.registerTool({
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
    parameters: Type.Object({
      action: StringEnum(["add", "list", "show", "comment", "plan", "edit-plan", "assign", "pick", "review", "done", "drop", "block", "archive", "summary"] as const),
      // add
      title: Type.Optional(Type.String({ description: "Task title (required for add)" })),
      description: Type.Optional(Type.String({ description: "Task description or acceptance criteria" })),
      itemType: Type.Optional(
        StringEnum(["task", "initiative", "milestone", "bug", "chore", "spec"] as const, {
          description: "Item type: task (default), initiative, milestone, bug, chore, spec",
        })
      ),
      files: Type.Optional(Type.Array(Type.String({ description: "Related file paths (auto-reserved on pick)" }))),
      dependsOn: Type.Optional(Type.Array(Type.String({ description: "Task IDs this task depends on (for add)" }))),
      parentId: Type.Optional(Type.String({ description: "Parent item ID for hierarchy (for add)" })),
      order: Type.Optional(Type.Number({ description: "Sort order within siblings (for add)" })),
      urgent: Type.Optional(Type.Boolean({ description: "If true, prepend to backlog instead of append" })),
      // assign, pick, done, drop, block
      id: Type.Optional(Type.String({ description: "Task ID (e.g. TASK-01)" })),
      to: Type.Optional(Type.String({ description: "Agent name to assign the task to" })),
      reason: Type.Optional(Type.String({ description: "Reason for blocking, or approach note for pick" })),
      summary: Type.Optional(Type.String({ description: "Summary for review or done. For review, include commit/branch, diff summary, tests run, and known risks." })),
      content: Type.Optional(Type.String({ description: "Comment text (for comment), or markdown spec content (for plan)" })),
      notify: Type.Optional(Type.Boolean({ description: "For comment: notify task subscribers (default true). Set false for silent comments." })),
      silent: Type.Optional(Type.Boolean({ description: "For comment: if true, do not notify task subscribers." })),
      // list
      status: Type.Optional(Type.String({ description: "Filter by status: todo, assigned, in-progress, review, done, blocked" })),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        // -- add ----------------------------------------------
        case "add": {
          if (!myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.title) throw new Error("Title is required for add.");

          const now = new Date().toISOString();

          // Validate parent reference if provided
          if (params.parentId) {
            const parent = await getTask(mySession, params.parentId);
            if (!parent) throw new Error(`Parent item ${params.parentId} not found.`);
          }

          const task = await addTask(
            mySession,
            {
              title: params.title,
              description: params.description,
              itemType: params.itemType as BacklogItem["itemType"],
              status: "todo",
              dependsOn: params.dependsOn,
              parentId: params.parentId,
              order: params.order,
              files: params.files,
              createdBy: myName,
              createdAt: now,
              updatedAt: now,
            },
            params.urgent
          );

          const urgentNote = params.urgent ? " (urgent  -- top of backlog)" : "";
          const typeNote = task.itemType && task.itemType !== "task" ? `\n  Type: ${task.itemType}` : "";
          const filesNote = task.files?.length ? `\n  Files: ${task.files.join(", ")}` : "";
          const depsNote = task.dependsOn?.length ? `\n  Depends on: ${task.dependsOn.join(", ")}` : "";
          return {
            content: [{
              type: "text",
              text: `Created ${task.id}: ${task.title}${urgentNote}${typeNote}${depsNote}${filesNote}`,
            }],
            details: { task },
          };
        }

        // -- list ---------------------------------------------
        case "list": {
          const tasks = await readBacklog(mySession);
          let filtered = tasks;

          if (params.status) {
            filtered = filtered.filter((t) => t.status === params.status);
          }

          if (filtered.length === 0) {
            const filterNote = params.status ? ` with status "${params.status}"` : "";
            return {
              content: [{ type: "text", text: `No tasks found${filterNote}.` }],
              details: { tasks: [] },
            };
          }

          const lines = filtered.map((t) => {
            const pos = tasks.indexOf(t) + 1;
            return renderTaskListRow(t, tasks, pos, myId);
          });

          return {
            content: [{ type: "text", text: `Backlog (${filtered.length} task${filtered.length !== 1 ? "s" : ""}):\n\n${lines.join("\n")}` }],
            details: { tasks: filtered },
          };
        }

        // -- show ---------------------------------------------
        case "show": {
          if (!params.id) throw new Error("Task ID is required for show.");
          const data = await serviceGetTaskShowData(mySession, params.id);
          const text = renderTaskDetails(data.task, data.allTasks, {
            currentAgentId: myId,
            comments: data.comments,
            specPreview: data.specPreview,
          });
          return {
            content: [{ type: "text", text }],
            details: { task: data.task, comments: data.comments },
          };
        }

        // -- comment ------------------------------------------
        case "comment": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for comment.");
          if (!params.content) throw new Error("Comment text is required (pass content parameter).");

          const task = await getTask(mySession, params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);

          const previousComments = readTaskComments(mySession, params.id);
          const comment = {
            id: newMessageId(),
            timestamp: new Date().toISOString(),
            agent: myName,
            agentId: myId,
            type: "comment" as const,
            text: params.content,
          };
          appendTaskComment(mySession, params.id, comment);

          const shouldNotify = params.silent === true ? false : params.notify !== false;
          const notified = shouldNotify
            ? await notifyTaskCommentSubscribers(mySession, task, previousComments, comment)
            : [];
          const notifyText = shouldNotify
            ? notified.length > 0 ? ` Notified: ${notified.join(", ")}.` : " No subscribers notified."
            : " Notifications skipped.";

          return {
            content: [{ type: "text", text: `Comment added to ${params.id}.${notifyText}` }],
            details: { taskId: params.id, commentId: comment.id, notified },
          };
        }

        // -- plan ---------------------------------------------
        case "plan": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for plan.");

          const task = await getTask(mySession, params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);

          const result = await planTaskSpec(mySession, task, params.content);
          const verb = result.updated ? "updated" : result.created ? "created" : "ready";
          const linkNote = result.linked ? "\nLinked specPath on backlog item." : "";
          return {
            content: [{
              type: "text",
              text: `Spec ${verb}: ${result.fullPath}${linkNote}\n\n${result.preview || "(empty)"}`,
            }],
            details: { taskId: params.id, specPath: result.specPath, fullPath: result.fullPath },
          };
        }

        // -- edit-plan ----------------------------------------
        case "edit-plan": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for edit-plan.");

          const task = await getTask(mySession, params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);

          const result = await planTaskSpec(mySession, task);

          return {
            content: [{
              type: "text",
              text: `Spec path: ${result.fullPath}\n\nUse read/edit tools to modify the spec.`,
            }],
            details: { taskId: params.id, specPath: result.specPath, fullPath: result.fullPath },
          };
        }

        // -- summary ------------------------------------------
        case "summary": {
          const summary = await buildProgressSummary(mySession);
          return {
            content: [{ type: "text", text: summary }],
            details: {},
          };
        }

        // -- archive ------------------------------------------
        case "archive": {
          const result = await archiveDoneTasks(mySession);
          const archivedIds = result.archived.map((t) => t.id).join(", ") || "none";
          const skippedText = result.skipped.length > 0
            ? `\nSkipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.item.id} (${s.reason})`).join(", ")}`
            : "";
          return {
            content: [{
              type: "text",
              text: `Archived ${result.archived.length} done item(s): ${archivedIds}.${skippedText}\nArchive: ${result.archivePath}`,
            }],
            details: result,
          };
        }

        // -- assign -------------------------------------------
        case "assign": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID(s) required for assign (comma-separated for batch).");
          if (!params.to) throw new Error("Target agent name is required for assign.");

          // Reject cross-session assignment
          const { session: targetSession } = parseAddress(params.to, mySession);
          if (targetSession !== mySession) {
            throw new Error(
              `Cross-session task assignment is not supported. ` +
              `"${params.to}" resolves to session "${targetSession}", but tasks ` +
              `can only be assigned to agents within the current session ("${mySession}").`
            );
          }

          const target = await resolveAgent(params.to, mySession);
          if (!target) throw new Error(`Agent "${params.to}" not found.`);

          const taskIds = params.id.split(",").map((s: string) => s.trim()).filter(Boolean);
          const result = await serviceAssignTasks(mySession, taskIds, target.id, target.name, myId, myName);

          // Pi-specific: deliver generic attention signal when service requests it.
          if (result.shouldSignal) {
            sendToInbox(mySession, result.targetId, {
              id: newMessageId(),
              from: myId,
              fromName: myName || "system",
              fromSession: mySession,
              timestamp: new Date().toISOString(),
              message: "Your amux state has changed. Check /amux or amux_task list for current tasks.",
            });
          }

          const assignedIds = result.assigned.map((t) => t.id).join(", ");
          return {
            content: [{
              type: "text",
              text: `Assigned ${assignedIds} to ${target.name}. Task state updated; visible via amux_task show.`,
            }],
            details: { tasks: result.assigned },
          };
        }

        // -- pick ---------------------------------------------
        case "pick": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");

          const pickResult = await servicePickTask(mySession, params.id || undefined, myId, myName);

          let pickText = `\u2713 Picked ${pickResult.task.id}: ${pickResult.task.title}`;
          if (params.reason) pickText += `\n  Approach: ${params.reason}`;
          if (pickResult.reserved.length > 0) pickText += `\n  Reserved: ${pickResult.reserved.join(", ")}`;
          if (pickResult.conflicts.length > 0) {
            pickText += `\n  \u26a0\ufe0f Could not reserve: ${pickResult.conflicts.map((c) => `${c.path} (${c.detail})`).join("; ")}`;
          }

          return {
            content: [{ type: "text", text: pickText }],
            details: pickResult,
          };
        }

        // -- review -------------------------------------------
        case "review": {
          if (!myId) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for review.");

          const reviewResult = await serviceReviewTask(mySession, params.id, myId, myName || "agent", params.summary);

          let reviewText = `◇ Ready for review ${reviewResult.task.id}: ${reviewResult.task.title}`;
          if (params.summary) {
            reviewText += `\n  Handoff: ${params.summary}`;
          } else {
            reviewText += `\n  Tip: include commit/branch, diff summary, tests run, and known risks in summary for token-efficient review.`;
          }
          reviewText += `\n  Reviewer flow: read spec → inspect diff → inspect tests → comment or done.`;
          if (reviewResult.released.length > 0) reviewText += `\n  Released: ${reviewResult.released.join(", ")}`;

          return {
            content: [{ type: "text", text: reviewText }],
            details: reviewResult,
          };
        }

        // -- done ---------------------------------------------
        case "done": {
          if (!myId) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for done.");

          const doneResult = await serviceCompleteTask(mySession, params.id, myId, myName || "agent", params.summary);

          let doneText = `\u2713 Completed ${doneResult.task.id}: ${doneResult.task.title}`;
          if (params.summary) doneText += `\n  Summary: ${params.summary}`;
          if (doneResult.released.length > 0) doneText += `\n  Released: ${doneResult.released.join(", ")}`;

          return {
            content: [{ type: "text", text: doneText }],
            details: doneResult,
          };
        }

        // -- drop ---------------------------------------------
        case "drop": {
          if (!myId) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for drop.");

          const dropResult = await serviceDropTask(mySession, params.id, myId, myName || "agent");

          let dropText = `\u2713 Dropped ${dropResult.task.id}: ${dropResult.task.title}  -- back in queue`;
          if (dropResult.released.length > 0) dropText += `\n  Released: ${dropResult.released.join(", ")}`;

          return {
            content: [{ type: "text", text: dropText }],
            details: dropResult,
          };
        }

        // -- block --------------------------------------------
        case "block": {
          if (!myId) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for block.");
          if (!params.reason) throw new Error("Reason is required for block.");

          const blockResult = await serviceBlockTask(mySession, params.id, myId, myName || "agent", params.reason);

          return {
            content: [{ type: "text", text: `\u26a0\ufe0f ${blockResult.task.id} blocked: ${params.reason}` }],
            details: blockResult,
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - amux_journal --------------------------------------------

  pi.registerTool({
    name: "amux_journal",
    label: "Journal",
    description:
      "Append-only journal for recording decisions, learnings, and progress. " +
      "Actions: add (record an entry), list (show recent entries). " +
      "Recent entries are automatically injected into the system prompt.",
    promptSnippet: "Record and review decisions, learnings, and progress",
    promptGuidelines: [
      "Use amux_journal to record important decisions, things you've learned, and progress updates.",
      "Journal entries are shared across all agents and persist across sessions.",
      "Recent entries are automatically included in the system prompt for context.",
      "When you discover ways to improve team alignment, code quality, or ways of working, capture them as a 'learning'  -- these shape how the team collaborates and raises the quality bar.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list"] as const),
      type: Type.Optional(
        StringEnum(["decision", "learning", "progress"] as const)
      ),
      content: Type.Optional(
        Type.String({ description: "Journal entry content (required for add)" })
      ),
      context: Type.Optional(
        Type.String({ description: "Optional context (e.g., task ID, topic)" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Number of entries to show (default 20, for list)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        case "add": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
          if (!params.type) throw new Error("Entry type is required for add (decision, learning, or progress).");
          if (!params.content) throw new Error("Content is required for add.");

          const entry = {
            timestamp: new Date().toISOString(),
            agent: myName,
            agentId: myId,
            type: params.type,
            content: params.content,
            context: params.context,
          };
          addJournalEntry(mySession, entry);

          return {
            content: [{
              type: "text",
              text: `✓ Journal entry added: ${formatJournalEntry(entry)}`,
            }],
            details: { entry },
          };
        }

        case "list": {
          const limit = params.limit ?? 20;
          const entries = readJournalEntries(mySession, limit, params.type);

          if (entries.length === 0) {
            const typeNote = params.type ? ` of type "${params.type}"` : "";
            return {
              content: [{ type: "text", text: `No journal entries found${typeNote}.` }],
              details: { entries: [] },
            };
          }

          const lines = entries.map((e) => `  ${formatJournalEntry(e)}`);
          const typeNote = params.type ? ` (${params.type})` : "";
          return {
            content: [{
              type: "text",
              text: `Journal${typeNote} (${entries.length} entries):\n\n${lines.join("\n")}`,
            }],
            details: { entries },
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // -- Commands -------------------------------------------------

  // -- /amux -- unified command with subcommands -----------------

  pi.registerCommand("amux", {
    description: "amux: join, leave, status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "";

      switch (sub) {
        case "":
          return handleStatus(ctx);
        case "join":
          return handleJoin(parts.slice(1).join(" "), ctx);
        case "leave":
          return handleLeave(ctx);
        case "workspace":
          return handleWorkspace(ctx);
        case "status":
          if (parts[1] === "set") return handleStatusSet(parts.slice(2), ctx);
          return handleStatus(ctx);
        case "progress":
          return handleProgress(ctx);
        case "show":
          return handleShow(parts.slice(1), ctx);
        case "new":
          return handleNew(parts.slice(1), ctx);
        case "wow":
          return handleWow(parts.slice(1), ctx);
        case "prompt":
          return handlePrompt(parts.slice(1), ctx);
        case "project":
          return handleProject(parts.slice(1), ctx);
        default:
          ctx.ui.notify(
            `Unknown: /amux ${sub}\n\nAvailable:\n  /amux              Status\n  /amux join          Join a project as an agent\n  /amux leave         Leave current project\n  /amux progress      Project progress overview\n  /amux show <id>     Show backlog item details\n  /amux new <type>    Create project, agent, or role directly\n  /amux project       Manage project vision/context\n  /amux wow           Show/edit team Ways of Working (WOW.md)\n  /amux prompt        Preview the amux coordination block for this agent\n  /amux status set    Set your availability (idle/working/focus/away)\n  /amux workspace     Git workspace setup and sync`,
            "warning"
          );
      }
    },
  });

  // -- status handler --

  async function handleStatus(ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify(
        "Not in a project.\n\n  /amux join       Join a project as an agent",
        "info"
      );
      return;
    }

    const agents = await getOnlineAgents(mySession);
    const backlog = await readBacklog(mySession);
    const agentLines = agents.map((a) =>
      renderAgentPresence(a, backlog, { currentAgentId: myId })
    );

    // Task state summary
    let taskLine = "";
    const inProgress = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === myId);
    const review = backlog.filter((t) => t.status === "review" && t.assigneeId === myId);
    const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === myId);
    if (inProgress.length > 0) {
      taskLine = `\nActive: ${inProgress[0]!.id} [in-progress] \u2014 ${inProgress[0]!.title}`;
    } else if (review.length > 0) {
      const ids = review.map((t) => t.id).join(", ");
      taskLine = `\n${review.length} ready for review: ${ids}`;
    } else if (assigned.length > 0) {
      const ids = assigned.map((t) => t.id).join(", ");
      taskLine = `\n${assigned.length} assigned task(s): ${ids}`;
    }

    // Availability
    const me = await findById(mySession, myId);
    const availStr = me?.availability ? ` | ${me.availability}${me.statusMessage ? `: ${me.statusMessage}` : ""}` : "";

    ctx.ui.notify(
      `Project: ${mySession} | Agent: ${myName} (${myRoleName || "no role"})${availStr}${taskLine}\n\nOnline:\n${agentLines.join("\n")}\n\n  /amux join          Switch project or agent\n  /amux leave         Leave project\n  /amux progress      Project progress overview\n  /amux show <id>     Show backlog item details\n  /amux new <type>    Create project, agent, or role directly\n  /amux project       Manage project vision/context\n  /amux wow           Show/edit team Ways of Working\n  /amux prompt        Preview the amux coordination block for this agent\n  /amux status set    Set your availability\n  /amux workspace     Git workspace setup and sync`,
      "info"
    );
  }

  // -- task detail handler --

  async function handleShow(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    const id = args[0];
    if (!id) {
      ctx.ui.notify("Usage: /amux show <ITEM-ID>\nExample: /amux show TASK-01", "warning");
      return;
    }

    try {
      const { text } = await buildTaskDetails(mySession, id, myId);
      ctx.ui.notify(text, "info");
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
    }
  }

  async function buildTaskDetails(
    session: string,
    id: string,
    viewerId?: string,
  ): Promise<{ text: string; task: BacklogItem; comments: ReturnType<typeof readTaskComments> }> {
    const tasks = await readBacklog(session);
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task ${id} not found.`);

    const comments = readTaskComments(session, task.id);
    const text = renderTaskDetails(task, tasks, {
      currentAgentId: viewerId,
      comments,
      specPreview: task.specPath ? readSpecPreview(session, task.specPath, 1024) : null,
    });

    return { text, task, comments };
  }

  async function notifyTaskCommentSubscribers(
    session: string,
    task: BacklogItem,
    previousComments: TaskComment[],
    comment: TaskComment,
  ): Promise<string[]> {
    if (!myId || !myName) return [];

    const registry = await readRegistry(session);
    const agents = Object.values(registry);
    const recipients = resolveTaskCommentSubscribers(task, previousComments, agents, myId, comment.text);
    const preview = taskCommentPreview(comment.text);
    const notified: string[] = [];

    for (const recipient of recipients) {
      const requiresAttention = true;
      if (shouldSignalAgent(recipient)) {
        await updateAgent(session, recipient.id, { attentionPending: true });
      }
      sendToInbox(session, recipient.id, {
        id: newMessageId(),
        from: myId,
        fromName: myName,
        fromRole: myRoleName,
        fromSession: session,
        timestamp: comment.timestamp,
        message: `${task.id} has a new comment from ${myName}: “${preview}”\nRun amux_task show ${task.id} for full context.`,
        category: "task-comment",
        taskId: task.id,
        notificationType: "task-comment",
        commentId: comment.id,
        preview,
        requiresAttention,
      });
      notified.push(recipient.name);
    }

    return notified;
  }

  // -- progress handler --

  async function handleProgress(ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }
    const summary = await buildProgressSummary(mySession);
    ctx.ui.notify(summary, "info");
  }

  async function buildProgressSummary(session: string): Promise<string> {
    const tasks = await readBacklog(session);
    return renderProgressSummary(session, tasks);
  }

  // -- join handler --

  async function handleJoin(projectArg: string, ctx: ExtensionContext): Promise<void> {
    // 1. Select project (no creation -- use /amux new project)
    let project = projectArg.trim();

    if (!project) {
      const existing = await listSessions();

      if (existing.length === 0) {
        ctx.ui.notify("No projects yet. Use /amux new project to create one.", "info");
        return;
      }

      const choice = await ctx.ui.select("Join project:", existing);
      if (!choice) { ctx.ui.notify("Cancelled.", "info"); return; }
      project = choice;
    }

    // Verify project exists
    const { existsSync } = await import("node:fs");
    if (!existsSync(sessionDir(project))) {
      ctx.ui.notify(`Project "${project}" not found. Use /amux new project to create it.`, "info");
      return;
    }

    // 2. Select agent (validation only — no state changes yet)
    const registry = await readRegistry(project);
    const allAgents = Object.values(registry);
    const previousAgentId = myId;
    const offlineAgents = allAgents.filter((a) => !isEffectivelyOnline(a) && a.id !== previousAgentId);
    const onlineAgents = allAgents.filter(isEffectivelyOnline);

    if (offlineAgents.length === 0 && onlineAgents.length === 0) {
      ctx.ui.notify(`No agents in "${project}". Use /amux new agent to create one.`, "info");
      return;
    }

    if (offlineAgents.length === 0) {
      const names = onlineAgents.map((a) => a.name).join(", ");
      ctx.ui.notify(
        `All agents in "${project}" are online (${names}). Use /amux new agent to create another.`,
        "info"
      );
      return;
    }

    const options = offlineAgents.map((a) => {
      const roleLabel = a.roleName ? ` (${a.roleName})` : "";
      return `${a.name}${roleLabel}`;
    });

    const agentChoice = await ctx.ui.select("Join as:", options);
    if (!agentChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

    // Resume selected agent
    const selectedName = agentChoice.split(" (")[0]!;
    const agent = offlineAgents.find((a) => a.name === selectedName);
    if (!agent) { ctx.ui.notify("Agent not found.", "error"); return; }

    // 3. COMMIT — selection confirmed, safe to transition state
    //    Previous agent goes offline only after new target is validated.
    if (myId && mySession) {
      await goOffline(mySession, myId);
      stopAgent();
    }

    mySession = project;
    myId = agent.id;
    myName = agent.name;
    myRole = agent.role;
    myRoleName = agent.roleName;
    if (agent.roleName) {
      await loadRoleInstructions(mySession, agent.roleName);
    }

    await updateAgent(mySession, myId, { cwd: ctx.cwd });
    await startAgent(ctx);

    // Apply saved model
    if (agent.model) {
      await trySetModel(ctx, agent.model);
    }

    const pending = getRecoverableMessages(mySession, myId);
    const pendingNote = pending.length > 0 ? `\n${pending.length} message(s) waiting.` : "";
    const modelNote = agent.model ? `\nModel: ${agent.model}` : "";
    const wsNote = agent.workspace ? `\nWorkspace: ${agent.workspace}` : "";
    ctx.ui.notify(
      `Joined "${project}" as "${myName}" (${myRoleName || "no role"}).${modelNote}${wsNote}${pendingNote}`,
      "info"
    );
  }

  // -- leave handler --

  async function handleLeave(ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify("Not in any project.", "info");
      return;
    }

    const projectName = mySession;

    await goOffline(mySession, myId);
    stopAgent();
    pi.appendEntry("amux-agent", { id: null, session: null });

    myId = undefined;
    myName = undefined;
    myRole = undefined;
    myRoleName = undefined;
    myRoleInstructions = undefined;
    mySession = undefined;

    ctx.ui.setStatus("amux", "");
    ctx.ui.setTitle("pi");

    ctx.ui.notify(`Left project "${projectName}". Back to solo Pi.`, "info");
  }

  /** Resolve which project to use. Uses current if joined, otherwise asks. */
  async function resolveProjectForCommand(ctx: ExtensionContext): Promise<string | null> {
    if (mySession) return mySession;

    const projects = await listSessions();

    if (projects.length === 0) {
      ctx.ui.notify("No projects yet. Create one with /amux new project.", "info");
      return null;
    }

    if (projects.length === 1) return projects[0]!;

    return (await ctx.ui.select("Which project?", projects)) ?? null;
  }


  // -- workspace handler --

  async function handleWorkspace(ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify("Join a project first with /amux join.", "warning");
      return;
    }

    const action = await ctx.ui.select("Workspace:", ["sync", "status"]);
    if (!action) return;

    const agent = await findById(mySession, myId);
    const workDir = agent?.workspace || ctx.cwd;
    const config = await readSessionConfig(mySession);

    switch (action) {
      case "sync": {
        if (!config.mainRepo) {
          ctx.ui.notify("No main repo configured for this project.", "warning");
          return;
        }

        const mainBranch = await pi.exec(
          "git", ["-C", config.mainRepo, "branch", "--show-current"],
          { timeout: 5000 }
        );
        const mainBranchName = mainBranch.stdout.trim() || "main";

        const fetch = await pi.exec("git", ["-C", workDir, "fetch", "origin"], { timeout: 30000 });
        const upstream = `origin/${mainBranchName}`;
        const rebase = await pi.exec("git", ["-C", workDir, "rebase", upstream], { timeout: 30000 });

        if (rebase.code !== 0) {
          ctx.ui.notify(`Rebase conflicts:\n${rebase.stderr}\n\nResolve, then: git rebase --continue`, "warning");
        } else {
          ctx.ui.notify(`Synced with ${upstream}. Up to date.`, "info");
        }
        break;
      }

      case "status": {
        const branch = await pi.exec("git", ["-C", workDir, "branch", "--show-current"], { timeout: 5000 });
        const status = await pi.exec("git", ["-C", workDir, "status", "--short"], { timeout: 5000 });

        const mainBranchName = config.mainRepo
          ? (await pi.exec("git", ["-C", config.mainRepo, "branch", "--show-current"], { timeout: 5000 })).stdout.trim() || "main"
          : "main";

        // Compare against remote ref for accuracy; fall back gracefully
        const upstream = `origin/${mainBranchName}`;
        const ahead = await pi.exec("git", ["-C", workDir, "rev-list", "--count", `${upstream}..HEAD`], { timeout: 5000 });
        const behind = await pi.exec("git", ["-C", workDir, "rev-list", "--count", `HEAD..${upstream}`], { timeout: 5000 });

        const aheadCount = ahead.code === 0 ? ahead.stdout.trim() : "? (remote ref not found)";
        const behindCount = behind.code === 0 ? behind.stdout.trim() : "? (remote ref not found)";

        const dirtyFiles = status.stdout.trim();
        const dirtyCount = dirtyFiles ? dirtyFiles.split("\n").length : 0;

        let info = `Branch: ${branch.stdout.trim() || "(detached)"}`;
        info += `\nWorktree: ${workDir}`;
        info += `\nAhead of ${upstream}: ${aheadCount} commits`;
        info += `\nBehind ${upstream}: ${behindCount} commits`;
        info += `\nDirty files: ${dirtyCount}`;
        if (dirtyFiles) info += `\n\n${dirtyFiles}`;

        ctx.ui.notify(info, "info");
        break;
      }
    }
  }


  // -- new command shortcuts ------------------------------------

  async function handleNew(args: string[], ctx: ExtensionContext): Promise<void> {
    const what = args[0];
    switch (what) {
      case "project": return handleNewProject(args.slice(1), ctx);
      case "agent": return handleNewAgent(args.slice(1), ctx);
      case "role": return handleNewRole(args.slice(1), ctx);
      default:
        ctx.ui.notify(
          "Usage:\n  /amux new project [name]\n  /amux new agent [name] [--role <role>] [--workspace worktree|current|none] [--join]\n  /amux new role [name]",
          "info"
        );
    }
  }

  async function handleNewProject(args: string[], ctx: ExtensionContext): Promise<void> {
    const { positional, flags } = parseShortcutArgs(args);
    let name = positional[0];
    if (!name) {
      name = await ctx.ui.input("Project name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    if (existsSync(sessionDir(name))) {
      ctx.ui.notify(`Project "${name}" already exists.`, "warning");
      return;
    }

    const setRepo = flags.repo !== undefined
      ? true
      : await ctx.ui.confirm("Main repo?", "Set current directory as the main repo?");

    mkdirSync(sessionDir(name), { recursive: true });

    const config: SessionConfig = { createdAt: new Date().toISOString() };
    if (setRepo) {
      config.mainRepo = (typeof flags.repo === "string" && flags.repo !== "current") ? flags.repo : ctx.cwd;
    }
    await writeSessionConfig(name, config);
    ensureDefaultWaysOfWorking(name);

    let visionSet = false;
    const shouldSetVision = flags.vision !== undefined
      ? true
      : await ctx.ui.confirm("Project vision?", "Set the project vision/context now? This is the first alignment artifact for agents.");
    if (shouldSetVision) {
      const vision = typeof flags.vision === "string"
        ? flags.vision
        : await ctx.ui.editor("Project vision/context:", "# Project Context\n\n## Vision\n\n");
      if (vision?.trim()) {
        writeProjectContext(name, vision.trim());
        visionSet = true;
      }
    }

    let msg = `Created project "${name}".`;
    if (setRepo) msg += `\nMain repo: ${config.mainRepo}`;
    msg += `\nDefault Ways of Working created.`;
    msg += visionSet
      ? `\nProject vision/context set.`
      : `\n\nNext alignment step: /amux project vision set <vision>`;
    msg += `\nThen: /amux new agent <name> --role <role>`;
    ctx.ui.notify(msg, "info");
  }

  async function handleNewAgent(args: string[], ctx: ExtensionContext): Promise<void> {
    const { positional, flags } = parseShortcutArgs(args);

    const session = await resolveProjectForCommand(ctx);
    if (!session) return;

    let name = positional[0];
    if (!name) {
      name = await ctx.ui.input("Agent name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    // Role
    let roleName: string | undefined = typeof flags.role === "string" ? flags.role : undefined;
    let roleToAdd: RoleDefinition | undefined;
    if (!roleName) {
      const projectRoles = await readRoles(session);
      const allRoles: RoleDefinition[] = [
        ...Object.values(projectRoles),
        ...BUILTIN_ROLES.filter((r) => !projectRoles[r.name]),
      ];
      if (allRoles.length > 0) {
        const roleOptions = allRoles.map((r) => `${r.name} -- ${r.description || r.instructions.slice(0, 60)}`);
        const roleChoice = await ctx.ui.select("Role:", roleOptions);
        if (roleChoice) roleName = roleChoice.split(" -- ")[0]!;
      }
    }
    if (roleName) {
      const projectRoles = await readRoles(session);
      if (!projectRoles[roleName]) {
        roleToAdd = BUILTIN_ROLES.find((r) => r.name === roleName);
      }
    }

    // Workspace
    const wsType = typeof flags.workspace === "string" ? flags.workspace : "none";
    let workspace: string | undefined;
    const config = await readSessionConfig(session);

    if (wsType === "worktree" && config.mainRepo) {
      const { basename: bn, dirname: dn } = await import("node:path");
      const repoName = bn(config.mainRepo);
      const parentDir = dn(config.mainRepo);
      const wsPath = `${parentDir}/${repoName}-${sanitizeBranchName(name)}`;
      const branchName = `agent/${sanitizeBranchName(name)}`;

      const result = await pi.exec("git", ["-C", config.mainRepo, "worktree", "add", wsPath, "-b", branchName], { timeout: 30000 });
      if (result.code !== 0) {
        const retry = await pi.exec("git", ["-C", config.mainRepo, "worktree", "add", wsPath, branchName], { timeout: 30000 });
        if (retry.code !== 0) {
          ctx.ui.notify(`Worktree failed: ${retry.stderr}\nAgent created without workspace.`, "warning");
        } else {
          workspace = wsPath;
        }
      } else {
        workspace = wsPath;
      }
    } else if (wsType === "current") {
      workspace = ctx.cwd;
    } else if (wsType === "worktree" && !config.mainRepo) {
      ctx.ui.notify("No main repo configured. Use /amux new project --repo current to set one.", "warning");
    }

    // Create
    if (roleToAdd) await addRole(session, roleToAdd);

    const agent: AgentInfo = {
      id: newAgentId(),
      name,
      session,
      role: roleName ?? `Agent ${name}`,
      roleName,
      workspace,
      model: currentModelStr,
      cwd: workspace || ctx.cwd,
      pid: 0,
      status: "offline",
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };

    try {
      await registerAgent(session, agent);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return;
    }

    if (flags.join) {
      if (myId && mySession) {
        await goOffline(mySession, myId);
        stopAgent();
      }
      mySession = session;
      myId = agent.id;
      myName = agent.name;
      myRole = agent.role;
      myRoleName = agent.roleName;
      if (agent.roleName) await loadRoleInstructions(mySession, agent.roleName);
      await updateAgent(mySession, myId, { cwd: ctx.cwd });
      await startAgent(ctx);
      if (agent.model) await trySetModel(ctx, agent.model);
      ctx.ui.notify(`Created and joined "${session}" as "${name}".`, "info");
    } else {
      let msg = `Agent "${name}" created (offline).`;
      if (roleName) msg += `\nRole: ${roleName}`;
      if (workspace) msg += `\nWorkspace: ${workspace}`;
      msg += `\nUse /amux join to start working as this agent.`;
      ctx.ui.notify(msg, "info");
    }
  }

  async function handleNewRole(args: string[], ctx: ExtensionContext): Promise<void> {
    const session = await resolveProjectForCommand(ctx);
    if (!session) return;

    let name = args[0];
    if (!name) {
      name = await ctx.ui.input("Role name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    const desc = await ctx.ui.input("Short description:");
    const instructions = await ctx.ui.editor("Instructions:", "");
    if (!instructions?.trim()) { ctx.ui.notify("Cancelled (instructions required).", "info"); return; }

    await addRole(session, { name, description: desc || undefined, instructions: instructions.trim() });
    ctx.ui.notify(`Role "${name}" added to "${session}".`, "info");
  }

  // -- project/context commands --------------------------------

  // -- prompt preview handler --

  /**
   * `/amux prompt` — debug/preview of the composed amux coordination block.
   * Shows exactly what amux APPENDS to the host agent runtime's base system
   * prompt for the joined agent (the base prompt itself is never shown). Uses the same gathering
   * path (gatherPromptSections) as the before_agent_start hook, so the preview
   * cannot drift from what is actually injected.
   */
  async function handlePrompt(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId || !myName) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }
    try {
      const sections = await gatherPromptSections();
      const target = args[0]?.trim();
      if (!target) {
        ctx.ui.notify(formatPromptSummary(sections), "info");
        return;
      }
      if (target === "all") {
        ctx.ui.notify(formatPromptPreview(sections), "info");
        return;
      }
      const section = PROMPT_SECTION_ORDER.find((key) => key === target);
      if (!section) {
        ctx.ui.notify(
          `Usage: /amux prompt [all|section]\n\nSections: ${PROMPT_SECTION_ORDER.join(", ")}`,
          "warning"
        );
        return;
      }
      ctx.ui.notify(formatPromptSectionPreview(sections, section), "info");
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function handleProject(args: string[], ctx: ExtensionContext): Promise<void> {
    const sub = args[0] || "show";
    if (sub === "vision") {
      return handleContext(args.slice(1), ctx);
    }
    return handleContext(args, ctx);
  }

  async function handleContext(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    ensureArtifactDirs();
    const contextPath = projectContextPath(mySession);
    const sub = args[0] || "show";

    switch (sub) {
      case "show": {
        const content = readProjectContext(mySession);
        if (!content) {
          ctx.ui.notify(`No project vision/context set.\n\nUse /amux project vision set <text>`, "info");
        } else {
          ctx.ui.notify(`Project vision/context (${contextPath}):\n\n${content}`, "info");
        }
        break;
      }
      case "edit": {
        const current = readProjectContext(mySession, 0) || "";
        const result = await ctx.ui.editor("Edit project vision/context:", current);
        if (result === null || result === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
        writeProjectContext(mySession, result);
        ctx.ui.notify("Project vision/context updated. Changes affect future agent prompts.", "info");
        break;
      }
      case "set": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux project vision set <text>", "warning"); return; }
        writeProjectContext(mySession, text);
        ctx.ui.notify("Project vision/context set. Changes affect future agent prompts.", "info");
        break;
      }
      case "append": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux project vision append <text>", "warning"); return; }
        appendProjectContext(mySession, text);
        ctx.ui.notify("Appended to project vision/context. Changes affect future agent prompts.", "info");
        break;
      }
      case "clear": {
        const confirm = await ctx.ui.confirm("Clear project vision/context?", "Remove all project context? This affects future agent prompts.");
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }
        clearProjectContext(mySession);
        ctx.ui.notify("Project vision/context cleared.", "info");
        break;
      }
      case "path": {
        ctx.ui.notify(contextPath, "info");
        break;
      }
      default:
        ctx.ui.notify(
          "Usage:\n  /amux project                         Show project vision/context\n  /amux project vision set <t>          Replace project vision/context\n  /amux project vision append <t>       Append to project vision/context\n  /amux project vision edit             Open editor\n  /amux project vision clear            Clear project vision/context\n  /amux project vision path             Show CONTEXT.md path",
          "info"
        );
    }
  }


  // -- wow handler --

  async function handleWow(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    const sub = args[0] || "show";

    switch (sub) {
      case "show": {
        const content = readWaysOfWorking(mySession);
        const path = wowPath(mySession);
        if (!content) {
          ctx.ui.notify(`No Ways of Working set.\n\nUse /amux wow edit  or  /amux wow set <text>`, "info");
        } else {
          ctx.ui.notify(`Ways of Working (${path}):\n\n${content}`, "info");
        }
        break;
      }
      case "edit": {
        const current = readWaysOfWorking(mySession, 0) || "";
        const result = await ctx.ui.editor("Edit Ways of Working:", current);
        if (result === null || result === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
        writeWaysOfWorking(mySession, result);
        ctx.ui.notify("Ways of Working updated. Changes affect future agent prompts.", "info");
        break;
      }
      case "set": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux wow set <text>", "warning"); return; }
        writeWaysOfWorking(mySession, text);
        ctx.ui.notify("Ways of Working set. Changes affect future agent prompts.", "info");
        break;
      }
      case "append": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux wow append <text>", "warning"); return; }
        appendWaysOfWorking(mySession, text);
        ctx.ui.notify("Appended to Ways of Working. Changes affect future agent prompts.", "info");
        break;
      }
      case "clear": {
        const confirm = await ctx.ui.confirm("Clear Ways of Working?", "Remove all team Ways of Working? This affects future agent prompts.");
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }
        clearWaysOfWorking(mySession);
        ctx.ui.notify("Ways of Working cleared.", "info");
        break;
      }
      case "path": {
        ctx.ui.notify(wowPath(mySession), "info");
        break;
      }
      default:
        ctx.ui.notify(
          "Usage:\n  /amux wow               Show current WoW\n  /amux wow edit          Open editor\n  /amux wow set <t>       Replace WoW\n  /amux wow append <t>    Append to WoW\n  /amux wow clear         Clear WoW\n  /amux wow path          Show WOW.md path",
          "info"
        );
    }
  }


  // -- status set command ---------------------------------------

  async function handleStatusSet(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    const validStates = ["idle", "working", "focus", "away"];
    const state = args[0];
    if (!state || !validStates.includes(state)) {
      ctx.ui.notify(
        "Usage: /amux status set <idle|working|focus|away> [message]",
        "info"
      );
      return;
    }

    const message = args.slice(1).join(" ").trim() || undefined;
    await updateAgent(mySession, myId, {
      availability: state as AgentInfo["availability"],
      statusMessage: message,
      availabilityUpdatedAt: new Date().toISOString(),
    });

    ctx.ui.notify(
      `Availability set to ${state}${message ? `: ${message}` : ""}.`,
      "info"
    );
  }


  // -- Helpers --------------------------------------------------

  /**
   * Sanitize an agent name for use as a git branch component.
   * Lowercases, replaces special characters with hyphens, collapses
   * consecutive hyphens, and trims leading/trailing hyphens.
   */
  function sanitizeBranchName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/\.\./g, "-")       // no consecutive dots (git ref rule)
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      || "unnamed";
  }

  /** Parse shortcut command arguments into positional args and --flag values. */
  function parseShortcutArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i]!.startsWith("--")) {
        const key = args[i]!.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      } else {
        positional.push(args[i]!);
      }
    }
    return { positional, flags };
  }

  // -- Artifacts ------------------------------------------------

  function projectArtifactsDir(): string {
    return sessionFile(mySession!, "artifacts", "project");
  }


  function agentArtifactsDir(agentId: string): string {
    return sessionFile(mySession!, "artifacts", "agents", agentId);
  }

  function ensureArtifactDirs(): void {
    if (!mySession || !myId) return;
    mkdirSync(projectArtifactsDir(), { recursive: true });
    mkdirSync(agentArtifactsDir(myId), { recursive: true });
  }

  function listFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  }

  async function trySetModel(ctx: ExtensionContext, modelStr: string): Promise<void> {
    let found = false;

    if (modelStr.includes("/")) {
      const [provider, id] = modelStr.split("/", 2);
      const model = ctx.modelRegistry.find(provider!, id!);
      if (model) found = !!(await pi.setModel(model));
    }

    if (!found) {
      for (const provider of ["anthropic", "openai", "google", "local-openai"]) {
        const model = ctx.modelRegistry.find(provider, modelStr);
        if (model) {
          found = !!(await pi.setModel(model));
          if (found) break;
        }
      }
    }

    if (!found) {
      ctx.ui.notify(`amux: model "${modelStr}" not found  -- using default`, "warning");
    }
  }

  async function refreshStatusWidget(ctx: ExtensionContext): Promise<void> {
    if (!mySession) return;

    try {
      const agents = await getOnlineAgents(mySession);
      const theme = ctx.ui.theme;
      const me = agents.find((a) => a.id === myId);

      if (!me) {
        ctx.ui.setStatus("amux", theme.fg("accent", `amux: ${myName || "unknown"}@${mySession}`) + theme.fg("dim", " (offline)"));
        return;
      }

      // The host footer is width-limited and may clip long status text, so put
      // the active identity first. Do not artificially cap the rest: if the host
      // clips, it clips less-important teammate detail after the active agent.
      const others = agents.filter((a) => a.id !== myId);
      const teammateSummary = others.length > 0
        ? theme.fg("dim", ` | ${others.map((a) => a.name).join(", ")}`)
        : "";
      const roleSummary = me.roleName ? theme.fg("dim", ` | ${me.roleName}`) : "";
      ctx.ui.setStatus("amux", theme.fg("accent", `◆ ${me.name}@${mySession}`) + teammateSummary + roleSummary);
    } catch {
      // Ignore widget errors
    }
  }
}
