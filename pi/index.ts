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
 *         amux_reserve, amux_task, amux_journal
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  removeAgent,
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
  shouldSignalAgentForWork,
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
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  watchInbox,
  newMessageId,
  type InboxMessage,
} from "../core/messaging";
import {
  reserve,
  release,
  getReservations,
  checkConflict,
  clearStaleReservations,
  toWorkspaceRelative,
} from "../core/reservations";
import {
  type Task,
  type BacklogItem,
  readBacklog,
  writeBacklog,
  addTask,
  getTask,
  nextTaskId,
  unmetDependencies,
  readSpecPreview,
  planTaskSpec,
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
} from "../core/task-comments";
import {
  renderTaskListRow,
  renderTaskDetails,
  renderProgressSummary,
  formatDuration,
} from "../core/renderers";



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

      const prefix = msg.fromRole
        ? `[amux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[amux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
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

      const prefix = msg.fromRole
        ? `[amux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[amux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
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
    myRoleInstructions = role.instructions;
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
    const reasonStr = reservation.reason ? ` (${reservation.reason})` : "";
    const staleNote = stale ? " [agent offline  -- stale reservation]" : "";
    const warning =
      `⚠️ ${filePath} is reserved by ${reservation.agent}${reasonStr}${staleNote}. ` +
      `Consider coordinating via amux_send('${reservation.agent}', ...).`;

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

    let extra = "";

    // Inject role instructions
    if (myRoleInstructions) {
      extra += `\n\n## Your Role: ${myRoleName}\n${myRoleInstructions}`;
    }

    // Inject workspace info
    if (myId) {
      const agent = await findById(mySession, myId);
      if (agent?.workspace) {
        const branchResult = await pi.exec("git", ["-C", agent.workspace, "branch", "--show-current"], { timeout: 5000 });
        const branch = branchResult.stdout?.trim() || "unknown";
        extra += `\n\n## Your Workspace\nPath: ${agent.workspace}\nBranch: ${branch}\nUse this as your working directory for all file operations.`;
      }
    }

    // Inject current task state (state-derived, never stale)
    if (myId) {
      const backlog = await readBacklog(mySession);
      const inProgress = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === myId);
      const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === myId);

      if (inProgress.length > 0) {
        const active = inProgress[0]!;
        extra += `\n\n## Active Task\n${active.id}: ${active.title}`;
        if (active.parentId) {
          const parent = backlog.find((t) => t.id === active.parentId);
          if (parent) extra += `\nParent: ${parent.id}: ${parent.title}`;
        }
        if (active.files?.length) extra += `\nFiles: ${active.files.join(", ")}`;
        if (active.specPath) {
          const spec = readSpecPreview(mySession, active.specPath, 2000);
          if (spec) extra += `\n\n${spec}`;
        }
        const comments = readTaskComments(mySession, active.id);
        if (comments.length > 0) {
          const recent = comments.slice(-3);
          extra += `\nRecent activity:\n${recent.map((c) => `- ${formatTaskComment(c)}`).join("\n")}`;
        }
      }

      if (assigned.length > 0) {
        const ids = assigned.map((t) => `${t.id}: ${t.title}`).join("\n  ");
        extra += `\n\n## Assigned Tasks (${assigned.length})\n  ${ids}\n\nUse amux_task show <id> for details, or amux_task pick <id> to start working.`;
      }
    }

    // Inject project context (CONTEXT.md)
    const projectCtx = readContextFile(projectArtifactsDir());
    if (projectCtx) {
      extra += `\n\n## Project Context\n${projectCtx}`;
    }

    // Inject recent journal entries (sliding window)
    const recentJournal = getRecentEntries(mySession);
    if (recentJournal.length > 0) {
      const journalLines = recentJournal.map((e) => `- ${formatJournalEntry(e)}`);
      extra += `\n\n## Recent Journal\n${journalLines.join("\n")}`;
    }

    // Gather all agents in this project (online + offline)
    const registry = await readRegistry(mySession);
    const projectAgents = Object.values(registry).filter((a) => a.id !== myId);

    // Cross-session agents (online only)
    const allAgents = await readAllRegistries();
    const crossSessionAgents = allAgents.filter(
      (a) => a.session !== mySession && isEffectivelyOnline(a)
    );

    const hasOthers = projectAgents.length > 0 || crossSessionAgents.length > 0;

    if (!hasOthers && !extra) return;

    if (hasOthers) {
      extra += `\n\n## Multi-Agent Environment (amux)`;
      extra += `\nYou are agent "${myName}" in session "${mySession}" (full address: ${myAddress()}).`;
      if (myRoleName) extra += `\nRole: ${myRoleName}.`;

      if (projectAgents.length > 0) {
        const list = projectAgents
          .map((a) => {
            const roleLabel = a.roleName || a.role;
            const avail = a.availability ? `, ${a.availability}` : "";
            return `  - ${a.name} (${roleLabel}) [${a.status}${avail}]`;
          })
          .join("\n");
        extra += `\n\nSame-session agents (address as "${mySession}/<name>" or just "<name>"):\n${list}`;
      }


      if (crossSessionAgents.length > 0) {
        const list = crossSessionAgents
          .map((a) => {
            const parts = [a.roleName || a.role, a.name].filter(Boolean);
            return `  - ${formatAddress(a.session, a.name)}: ${parts.join(":")} [${a.status}]`;
          })
          .join("\n");
        extra += `\nCross-session agents (must use full address "session/name"):\n${list}`;
      }

      extra += `\n
### Addressing
- Same-session agents: use just the name (e.g., "backend") or full address ("${mySession}/backend")
- Cross-session agents: always use the full address ("othersession/agentname")

### Communication
- Use amux_task for task workflow: add, assign, pick, show, comment, done/drop/block, and summary.
- Use amux_task comment for task-scoped discussion, like PR comments. Prefer comments over amux_send for task feedback.
- Use amux_send only for exceptional general communication that is not tied to a backlog item.
- Use amux_list to refresh the list of available agents (set allSessions=true for cross-session).
- Messages from other agents appear as "[amux:session/agent (role)] message".
- When you receive a [amux:...] message, treat it as a request from a teammate and respond helpfully.
- Reply using amux_send with the sender's address.

### Backlog workflow
- Use amux_task summary (or /amux progress) for a compact hierarchical overview before choosing work.
- Backlog items may be typed: initiative, milestone, task, bug, chore, or spec. IDs reflect type (INIT-*, MS-*, TASK-*, BUG-*, CHORE-*, SPEC-*).
- High-level items such as initiatives and milestones are context containers. Prefer assigning executable leaf items (task/bug/chore/spec), not container items.
- When creating a high-level item with children, first create and review the overall structure and context. Assign/delegate child work only after the parent item is sufficiently defined.
- When working on a child item, inspect its parent context with amux_task show before picking or implementing.
- Task assignment is state-derived: assigned work appears in backlog/progress and prompt context; task details are not sent as inbox messages.`;
    }

    // Artifact paths  -- always include when agent has identity
    if (myId) {
      extra += `\n\n### Shared Artifacts\nRead and write shared documents using the standard read/write/edit tools.`;
      extra += `\n- Project (all agents): ${projectArtifactsDir()}`;
      extra += `\n- Private (you only): ${agentArtifactsDir(myId)}`;
    }

    return { systemPrompt: event.systemPrompt + extra };
  });

  // -- Tools ----------------------------------------------------

  // - amux_role -------------------------------------------------

  pi.registerTool({
    name: "amux_role",
    label: "Manage Roles",
    description:
      "Add, list, or remove role definitions for the current amux session. " +
      "Roles define a name and instructions that shape an agent's behavior. " +
      "Agents join projects with /amux join.",
    promptSnippet: "Add, list, or remove amux role definitions",
    promptGuidelines: [
      "Use amux_role to define roles before agents join with /amux join.",
      "Each amux_role has a name and instructions that guide the agent's behavior.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "remove"] as const),
      name: Type.Optional(
        Type.String({ description: 'Role name (required for "add" and "remove")' })
      ),
      instructions: Type.Optional(
        Type.String({
          description:
            'Instructions for the role  -- what the agent should do, focus on, and how to behave (required for "add")',
        })
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
      for (const [session, sessionAgents] of bySession) {
        const isCurrent = session === mySession;
        const header = isCurrent ? `Session: ${session} (current)` : `Session: ${session}`;
        const lines = sessionAgents.map((a) => {
          const isMe = a.id === myId;
          const marker = isMe ? " (you)" : "";
          const addr = formatAddress(session, a.name);
          const label = [a.roleName, a.name].filter(Boolean).join(":");
          return `  - ${addr}${marker} [${a.status}]: ${label} (cwd: ${a.cwd})`;
        });
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
      "Delivered to the agent's inbox  -- works even if they're busy or offline.",
    promptSnippet: "Send a message to a amux agent by name or session/name address",
    promptGuidelines: [
      "Use amux_list first to see which agents are available before using amux_send.",
      "When using amux_send, be specific about what you need from the other agent.",
      'For cross-session agents, use the full address in amux_send: "session/name".',
      "After using amux_send, do not wait  -- continue with your own work unless you need their response first.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: '"name" for same session, or "session/name" for cross-session' }),
      message: Type.String({ description: "Message or instruction to send" }),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
        throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
        throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
          if (!myId) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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

          const now = Date.now();
          const lines = entries.map(([path, res]) => {
            const elapsed = now - new Date(res.since).getTime();
            const duration = formatDuration(elapsed);
            const reasonStr = res.reason ? `  -- ${res.reason}` : "";
            const stale = !onlineIds.has(res.agentId);
            const staleStr = stale ? " [stale  -- agent offline]" : "";
            const isMe = res.agentId === myId;
            const marker = isMe ? " (you)" : "";
            return `  ${path}  →  ${res.agent}${marker}${reasonStr} (${duration})${staleStr}`;
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
      "assign (delegate to same-session agent, comma-separated IDs for batch), pick (claim/accept task), done (complete), " +
      "drop (release back to queue), block (mark blocked). " +
      "Tasks can declare dependencies via dependsOn. " +
      "Picking a task auto-reserves its files. Done/drop auto-releases them.",
    promptSnippet: "Manage task backlog  -- add, list, show, comment, plan, edit-plan, assign, pick, done, drop, block",
    promptGuidelines: [
      "Use action 'pick' to claim the next available task or accept an assigned task.",
      "Picking a task auto-reserves its files. Done/drop auto-releases them.",
      "Use action 'done' with a summary when completing a task.",
      "Use action 'assign' to delegate executable leaf work items to same-session agents  -- the assignee accepts by picking.",
      "Create and review high-level initiatives/milestones and their children before assigning executable child work.",
      "It is OK to assign all defined leaf work up front; use dependsOn to enforce order, and assignees should pick one item at a time after completing the current item.",
      "When working on a child item, inspect its parent context with amux_task show before picking or implementing.",
      "Use dependsOn when adding an item that should wait for other items to complete.",
      "Pass comma-separated IDs to assign multiple items in one state update.",
      "Only the assignee can done/drop/block an assigned item.",
      "Use 'show' to view item details, parent context, linked spec preview, and comment history.",
      "Use 'plan' and 'edit-plan' for first-class task-linked specs/checklists instead of ad-hoc project artifacts.",
      "Use 'comment' for task-scoped discussion  -- prefer over amux_send for task-related topics.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "show", "comment", "plan", "edit-plan", "assign", "pick", "done", "drop", "block", "summary"] as const),
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
      summary: Type.Optional(Type.String({ description: "Completion summary (for done)" })),
      content: Type.Optional(Type.String({ description: "Comment text (for comment), or markdown spec content (for plan)" })),
      // list
      status: Type.Optional(Type.String({ description: "Filter by status: todo, assigned, in-progress, done, blocked" })),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("amux session not active");

      switch (params.action) {
        // -- add ----------------------------------------------
        case "add": {
          if (!myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
          const { text, task, comments } = await buildTaskDetails(mySession, params.id, myId);
          return {
            content: [{ type: "text", text }],
            details: { task, comments },
          };
        }

        // -- comment ------------------------------------------
        case "comment": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for comment.");
          if (!params.content) throw new Error("Comment text is required (pass content parameter).");

          const task = await getTask(mySession, params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);

          appendTaskComment(mySession, params.id, {
            timestamp: new Date().toISOString(),
            agent: myName,
            agentId: myId,
            type: "comment",
            text: params.content,
          });

          return {
            content: [{ type: "text", text: `Comment added to ${params.id}.` }],
            details: { taskId: params.id },
          };
        }

        // -- plan ---------------------------------------------
        case "plan": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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

        // -- assign -------------------------------------------
        case "assign": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID(s) required for assign (comma-separated for batch).");
          if (!params.to) throw new Error("Target agent name is required for assign.");

          // Reject cross-session assignment — task lives in current session backlog
          const { session: targetSession } = parseAddress(params.to, mySession);
          if (targetSession !== mySession) {
            throw new Error(
              `Cross-session task assignment is not supported. ` +
              `"${params.to}" resolves to session "${targetSession}", but tasks ` +
              `can only be assigned to agents within the current session ("${mySession}").`
            );
          }

          const target = await resolveAgent(params.to, mySession);
          if (!target) {
            throw new Error(`Agent "${params.to}" not found.`);
          }

          // Support comma-separated IDs for batch assignment
          const taskIds = params.id.split(",").map((s: string) => s.trim()).filter(Boolean);

          const tasks = await readBacklog(mySession);
          const toAssign: Task[] = [];

          // Validate all tasks before assigning any
          for (const taskId of taskIds) {
            const task = tasks.find((t) => t.id === taskId);
            if (!task) throw new Error(`Task ${taskId} not found.`);
            if (task.status === "in-progress") {
              throw new Error(
                `${taskId} is actively being worked on by ${task.assignee}. Ask them to drop it first.`
              );
            }
            if (task.status === "done") throw new Error(`${taskId} is already done.`);
            toAssign.push(task);
          }

          // Assign all
          const now = new Date().toISOString();
          for (const task of toAssign) {
            task.status = "assigned";
            task.assignee = target.name;
            task.assigneeId = target.id;
            task.updatedAt = now;
          }
          await writeBacklog(mySession, tasks);

          // Record assignment activity
          for (const t of toAssign) {
            appendTaskComment(mySession, t.id, {
              timestamp: now,
              agent: myName,
              agentId: myId,
              type: "activity",
              text: `Assigned to ${target.name} by ${myName}`,
            });
          }

          // Generic attention signal for available agents (coalesced).
          // A stale `working` availability should not suppress assigned-work
          // nudges when the target has no active in-progress backlog item.
          const targetAgent = await findById(mySession, target.id);
          const targetHasActiveWork = tasks.some((t) =>
            t.status === "in-progress" && t.assigneeId === target.id
          );
          if (targetAgent && shouldSignalAgentForWork(targetAgent, targetHasActiveWork)) {
            await updateAgent(mySession, target.id, { attentionPending: true });
            sendToInbox(mySession, target.id, {
              id: newMessageId(),
              from: myId,
              fromName: myName || "system",
              fromSession: mySession,
              timestamp: new Date().toISOString(),
              message: "Your amux state has changed. Check /amux or amux_task list for current tasks.",
            });
          }

          const assignedIds = toAssign.map((t) => t.id).join(", ");
          return {
            content: [{
              type: "text",
              text: `Assigned ${assignedIds} to ${target.name}. Task state updated; visible via amux_task show.`,
            }],
            details: { tasks: toAssign },
          };
        }

        // -- pick ---------------------------------------------
        case "pick": {
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");

          const tasks = await readBacklog(mySession);
          let task: Task | undefined;

          if (params.id) {
            task = tasks.find((t) => t.id === params.id);
            if (!task) throw new Error(`Task ${params.id} not found.`);

            if (task.status === "assigned" && task.assigneeId !== myId) {
              throw new Error(
                `${params.id} is assigned to ${task.assignee}, waiting for their response.`
              );
            }
            if (task.status === "in-progress") {
              throw new Error(
                `${params.id} is already in progress${task.assignee ? ` by ${task.assignee}` : ""}.`
              );
            }
            if (task.status === "done") {
              throw new Error(`${params.id} is already done.`);
            }

            // Check dependency satisfaction
            const unmet = unmetDependencies(task, tasks);
            if (unmet.length > 0) {
              throw new Error(
                `${params.id} has unfinished dependencies: ${unmet.join(", ")}. ` +
                `Complete those tasks first.`
              );
            }
          } else {
            // Auto-pick: prefer assigned-to-self with met deps, then open todo
            task = tasks.find((t) => t.status === "assigned" && t.assigneeId === myId && unmetDependencies(t, tasks).length === 0)
              || tasks.find((t) => t.status === "todo" && unmetDependencies(t, tasks).length === 0);
            if (!task) {
              throw new Error(
                "No tasks available to pick. All tasks are assigned, in progress, blocked, done, or waiting on dependencies."
              );
            }
          }

          // Claim the task
          task.status = "in-progress";
          task.assignee = myName;
          task.assigneeId = myId;
          task.blockedReason = undefined;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          appendTaskComment(mySession, task.id, {
            timestamp: task.updatedAt,
            agent: myName,
            agentId: myId,
            type: "activity",
            text: `Picked by ${myName}`,
          });

          // Auto-set availability to working
          await updateAgent(mySession, myId, {
            availability: "working",
            availabilityUpdatedAt: new Date().toISOString(),
          });

          // Auto-reserve files (partial success  -- Option B)
          const reserved: string[] = [];
          const conflicts: Array<{ path: string; detail: string }> = [];

          if (task.files?.length) {
            const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
            const onlineIds = online.map((a) => a.id);
            const reserveReason = `${task.id}: ${task.title}`;

            for (const file of task.files) {
              try {
                await reserve(mySession, [file], myId, myName, reserveReason, onlineIds);
                reserved.push(file);
              } catch (err) {
                conflicts.push({
                  path: file,
                  detail: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }

          // Build response
          let text = `✓ Picked ${task.id}: ${task.title}`;
          if (params.reason) text += `\n  Approach: ${params.reason}`;
          if (reserved.length > 0) text += `\n  Reserved: ${reserved.join(", ")}`;
          if (conflicts.length > 0) {
            for (const c of conflicts) {
              text += `\n  ⚠️ Could not reserve: ${c.path}  -- ${c.detail}`;
            }
            text += `\n  → Consider coordinating via amux_send.`;
          }

          return {
            content: [{ type: "text", text }],
            details: { task, reserved, conflicts },
          };
        }

        // -- done ---------------------------------------------
        case "done": {
          if (!myId) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for done.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);

          if (task.assigneeId && task.assigneeId !== myId) {
            throw new Error(
              `${params.id} is assigned to ${task.assignee}. Only the assignee can mark it done.`
            );
          }

          task.status = "done";
          task.completedAt = new Date().toISOString();
          task.updatedAt = new Date().toISOString();
          if (params.summary) task.summary = params.summary;
          await writeBacklog(mySession, tasks);

          appendTaskComment(mySession, task.id, {
            timestamp: task.updatedAt,
            agent: myName || "agent",
            agentId: myId,
            type: "activity",
            text: `Completed${params.summary ? `: ${params.summary}` : ""}`,
          });

          // Auto-set idle if no other in-progress tasks (preserve focus/away)
          const remainingAfterDone = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === myId);
          if (remainingAfterDone.length === 0) {
            const agentSelf = await findById(mySession, myId);
            if (!agentSelf?.availability || agentSelf.availability === "working") {
              await updateAgent(mySession, myId, {
                availability: "idle",
                availabilityUpdatedAt: new Date().toISOString(),
              });
            }
          }

          // Auto-release file reservations
          let released: string[] = [];
          if (task.files?.length) {
            released = await release(mySession, task.files, myId);
          }

          let text = `✓ Completed ${task.id}: ${task.title}`;
          if (params.summary) text += `\n  Summary: ${params.summary}`;
          if (released.length > 0) text += `\n  Released: ${released.join(", ")}`;

          return {
            content: [{ type: "text", text }],
            details: { task, released },
          };
        }

        // -- drop ---------------------------------------------
        case "drop": {
          if (!myId) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for drop.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);
          if (task.status === "todo") throw new Error(`${params.id} is not assigned to anyone.`);

          if (task.assigneeId && task.assigneeId !== myId) {
            throw new Error(
              `${params.id} is assigned to ${task.assignee}. Only the assignee can drop it.`
            );
          }

          task.status = "todo";
          task.assignee = undefined;
          task.assigneeId = undefined;
          task.blockedReason = undefined;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          appendTaskComment(mySession, task.id, {
            timestamp: task.updatedAt,
            agent: myName || "agent",
            agentId: myId,
            type: "activity",
            text: `Dropped \u2014 back in queue`,
          });

          // Auto-set idle if no other in-progress tasks (preserve focus/away)
          const remainingAfterDrop = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === myId);
          if (remainingAfterDrop.length === 0) {
            const agentSelf = await findById(mySession, myId);
            if (!agentSelf?.availability || agentSelf.availability === "working") {
              await updateAgent(mySession, myId, {
                availability: "idle",
                availabilityUpdatedAt: new Date().toISOString(),
              });
            }
          }

          // Auto-release file reservations
          let released: string[] = [];
          if (task.files?.length) {
            released = await release(mySession, task.files, myId);
          }

          let text = `✓ Dropped ${task.id}: ${task.title}  -- back in queue`;
          if (released.length > 0) text += `\n  Released: ${released.join(", ")}`;

          return {
            content: [{ type: "text", text }],
            details: { task, released },
          };
        }

        // -- block --------------------------------------------
        case "block": {
          if (!myId) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
          if (!params.id) throw new Error("Task ID is required for block.");
          if (!params.reason) throw new Error("Reason is required for block.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);

          if (task.assigneeId && task.assigneeId !== myId) {
            throw new Error(
              `${params.id} is assigned to ${task.assignee}. Only the assignee can block it.`
            );
          }

          task.status = "blocked";
          task.blockedReason = params.reason;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          appendTaskComment(mySession, task.id, {
            timestamp: task.updatedAt,
            agent: myName || "agent",
            agentId: myId,
            type: "activity",
            text: `Blocked: ${params.reason}`,
          });

          return {
            content: [{ type: "text", text: `⚠️ ${task.id} blocked: ${params.reason}` }],
            details: { task },
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
          if (!myId || !myName) throw new Error("Not registered. Use /amux manage to set up, then /amux join.");
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
    description: "amux: join, leave, manage, status",
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
        case "manage":
          return handleManage(ctx);
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
        case "context":
          return handleContext(parts.slice(1), ctx);
        default:
          ctx.ui.notify(
            `Unknown: /amux ${sub}\n\nAvailable:\n  /amux              Status\n  /amux join          Join a project as an agent\n  /amux leave         Leave current project\n  /amux progress      Project progress overview\n  /amux show <id>     Show backlog item details\n  /amux manage        Manage projects, agents, and roles\n  /amux new <type>    Create project, agent, or role directly\n  /amux context       Show/edit project context (CONTEXT.md)\n  /amux status set    Set your availability (idle/working/focus/away)\n  /amux workspace     Git workspace setup and sync`,
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
    const agentLines = agents.map((a) => {
      const isMe = a.id === myId;
      const marker = isMe ? " <-" : "";
      const roleLabel = a.roleName ?? a.role;
      return `  ${a.name} (${roleLabel})${marker}`;
    });

    // Task state summary
    let taskLine = "";
    const backlog = await readBacklog(mySession);
    const inProgress = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === myId);
    const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === myId);
    if (inProgress.length > 0) {
      taskLine = `\nActive: ${inProgress[0]!.id} [in-progress] \u2014 ${inProgress[0]!.title}`;
    } else if (assigned.length > 0) {
      const ids = assigned.map((t) => t.id).join(", ");
      taskLine = `\n${assigned.length} assigned task(s): ${ids}`;
    }

    // Availability
    const me = await findById(mySession, myId);
    const availStr = me?.availability ? ` | ${me.availability}${me.statusMessage ? `: ${me.statusMessage}` : ""}` : "";

    ctx.ui.notify(
      `Project: ${mySession} | Agent: ${myName} (${myRoleName || "no role"})${availStr}${taskLine}\n\nOnline:\n${agentLines.join("\n")}\n\n  /amux join          Switch project or agent\n  /amux leave         Leave project\n  /amux progress      Project progress overview\n  /amux show <id>     Show backlog item details\n  /amux manage        Manage projects, agents, and roles\n  /amux new <type>    Create project, agent, or role directly\n  /amux context       Show/edit project context\n  /amux status set    Set your availability\n  /amux workspace     Git workspace setup and sync`,
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
  ): Promise<{ text: string; task: Task; comments: ReturnType<typeof readTaskComments> }> {
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
    // 1. Select project (no creation -- use /amux manage)
    let project = projectArg.trim();

    if (!project) {
      const existing = await listSessions();

      if (existing.length === 0) {
        ctx.ui.notify("No projects yet. Use /amux manage to create one.", "info");
        return;
      }

      const choice = await ctx.ui.select("Join project:", existing);
      if (!choice) { ctx.ui.notify("Cancelled.", "info"); return; }
      project = choice;
    }

    // Verify project exists
    const { existsSync } = await import("node:fs");
    if (!existsSync(sessionDir(project))) {
      ctx.ui.notify(`Project "${project}" not found. Use /amux manage to create it.`, "info");
      return;
    }

    // 2. Select agent (validation only — no state changes yet)
    const registry = await readRegistry(project);
    const allAgents = Object.values(registry);
    const previousAgentId = myId;
    const offlineAgents = allAgents.filter((a) => !isEffectivelyOnline(a) && a.id !== previousAgentId);
    const onlineAgents = allAgents.filter(isEffectivelyOnline);

    if (offlineAgents.length === 0 && onlineAgents.length === 0) {
      ctx.ui.notify(`No agents in "${project}". Use /amux manage to create one.`, "info");
      return;
    }

    if (offlineAgents.length === 0) {
      const names = onlineAgents.map((a) => a.name).join(", ");
      ctx.ui.notify(
        `All agents in "${project}" are online (${names}). Use /amux manage to create another.`,
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

  // -- manage handler --

  async function handleManage(ctx: ExtensionContext): Promise<void> {
    const what = await ctx.ui.select("Manage:", ["Projects", "Agents", "Roles"]);
    if (!what) return;

    if (what === "Projects") {
      await manageProjects(ctx);
    } else if (what === "Agents") {
      await manageAgents(ctx);
    } else {
      await manageRoles(ctx);
    }
  }


  /** Resolve which project to manage. Uses current if joined, otherwise asks. */
  async function resolveProjectForManage(ctx: ExtensionContext): Promise<string | null> {
    if (mySession) return mySession;

    const projects = await listSessions();

    if (projects.length === 0) {
      ctx.ui.notify("No projects yet. Create one with /amux manage > Projects.", "info");
      return null;
    }

    if (projects.length === 1) return projects[0]!;

    return (await ctx.ui.select("Which project?", projects)) ?? null;
  }

  async function manageProjects(ctx: ExtensionContext): Promise<void> {
    const projects = await listSessions();

    const NEW_PROJECT = "+ New project";
    const options = [...projects, NEW_PROJECT];

    const choice = await ctx.ui.select("Projects:", options);
    if (!choice) return;

    if (choice === NEW_PROJECT) {
      // ---- COLLECT ALL INPUTS ----
      const name = await ctx.ui.input("Project name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }

      const setRepo = await ctx.ui.confirm("Main repo?", "Set current directory as the main repo for this project?");

      let needsGitInit = false;
      if (setRepo) {
        const gitCheck = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
        if (gitCheck.code !== 0) {
          needsGitInit = await ctx.ui.confirm("Not a git repo", "Current directory is not a git repo. Initialize one?");
        }
      }

      // ---- EXECUTE ALL ACTIONS ----
      const { mkdirSync: mkDir } = await import("node:fs");
      mkDir(sessionDir(name), { recursive: true });

      if (needsGitInit) {
        await pi.exec("git", ["init"], { timeout: 5000 });
      }

      const newConfig: SessionConfig = { createdAt: new Date().toISOString() };
      if (setRepo) {
        newConfig.mainRepo = ctx.cwd;
      }
      await writeSessionConfig(name, newConfig);

      if (setRepo && myId && mySession === name) {
        await updateAgent(mySession, myId, { workspace: ctx.cwd });
      }

      ctx.ui.notify(`Project "${name}" created.${newConfig.mainRepo ? "\nMain repo: " + newConfig.mainRepo : ""}`, "info");
      return;
    }

    const project = choice;

    // Check for online agents
    const onlineCount = (await getOnlineAgents(project)).length;

    const actions = ["Set main repo", "Rename", "Delete"];
    const action = await ctx.ui.select(`Project "${project}":`, actions);
    if (!action) return;

    if (action === "Set main repo") {
      const gitCheck = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
      if (gitCheck.code !== 0) {
        const initGit = await ctx.ui.confirm("Not a git repo", "Current directory is not a git repo. Initialize one?");
        if (initGit) {
          await pi.exec("git", ["init"], { timeout: 5000 });
        } else {
          return;
        }
      }

      const config = await readSessionConfig(project);
      config.mainRepo = ctx.cwd;
      await writeSessionConfig(project, config);
      ctx.ui.notify(`Main repo set to: ${ctx.cwd}`, "info");

    } else if (action === "Delete") {
      if (onlineCount > 0) {
        ctx.ui.notify(`Cannot delete: ${onlineCount} agent(s) online. They must /amux leave first.`, "warning");
        return;
      }
      const confirm = await ctx.ui.confirm("Delete project?", `Permanently delete "${project}" and all its data?`);
      if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }

      const { rmSync } = await import("node:fs");
      rmSync(sessionDir(project), { recursive: true, force: true });
      ctx.ui.notify(`Deleted project "${project}".`, "info");

    } else if (action === "Rename") {
      if (onlineCount > 0) {
        ctx.ui.notify(`Cannot rename: ${onlineCount} agent(s) online. They must /amux leave first.`, "warning");
        return;
      }
      const newName = await ctx.ui.input("New name:", project);
      if (!newName || newName === project) { ctx.ui.notify("Cancelled.", "info"); return; }

      const { renameSync, readFileSync: readF, writeFileSync: writeF } = await import("node:fs");
      renameSync(sessionDir(project), sessionDir(newName));

      // Update session field in agent records
      try {
        const agentsPath = sessionFile(newName, "agents.json");
        const agents = JSON.parse(readF(agentsPath, "utf8"));
        for (const agent of Object.values(agents) as AgentInfo[]) {
          agent.session = newName;
        }
        writeF(agentsPath, JSON.stringify(agents, null, 2), "utf8");
      } catch {}

      ctx.ui.notify(`Renamed "${project}" to "${newName}".`, "info");
    }
  }

  async function manageAgents(ctx: ExtensionContext): Promise<void> {
    const session = await resolveProjectForManage(ctx);
    if (!session) return;

    const registry = await readRegistry(session);
    const allAgents = Object.values(registry);

    const NEW_AGENT = "+ New agent";
    const options = [
      ...allAgents.map((a) => {
        const roleLabel = a.roleName ? ` (${a.roleName})` : "";
        const status = isEffectivelyOnline(a) ? " [online]" : "";
        return `${a.name}${roleLabel}${status}`;
      }),
      NEW_AGENT,
    ];
    const selected = await ctx.ui.select("Agents:", options);
    if (!selected) return;

    if (selected === NEW_AGENT) {
      // ---- COLLECT ALL INPUTS FIRST ----

      const name = await ctx.ui.input("Agent name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }

      // Role
      const projectRoles = await readRoles(session);
      const allRoles: RoleDefinition[] = [
        ...Object.values(projectRoles),
        ...BUILTIN_ROLES.filter((r) => !projectRoles[r.name]),
      ];

      let roleName: string | undefined;
      let roleToAdd: RoleDefinition | undefined;
      if (allRoles.length > 0) {
        const roleOptions = allRoles.map((r) => {
          const desc = r.description || r.instructions.slice(0, 60);
          return `${r.name} -- ${desc}`;
        });
        const roleChoice = await ctx.ui.select("Role:", roleOptions);
        if (!roleChoice) { ctx.ui.notify("Cancelled.", "info"); return; }
        roleName = roleChoice.split(" -- ")[0]!;
        // Check if built-in needs copying
        if (!projectRoles[roleName]) {
          roleToAdd = allRoles.find((r) => r.name === roleName);
        }
      }


      // Model (pre-filled with current Pi model)
      let agentModel: string | undefined;
      const modelInput = await ctx.ui.editor("Model:", currentModelStr || "");
      if (modelInput?.trim()) {
        agentModel = modelInput.trim();
      }

      // Workspace
      let wsChoice: string | undefined;
      let wsPath: string | undefined;
      const config = await readSessionConfig(session);
      if (config.mainRepo) {
        const currentDirUsed = allAgents.some((a) => a.workspace === ctx.cwd);
        const wsOptions: string[] = ["New worktree"];
        if (!currentDirUsed) {
          wsOptions.push("Use current directory");
        }
        wsOptions.push("No workspace");

        wsChoice = await ctx.ui.select("Workspace:", wsOptions);
        if (!wsChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

        if (wsChoice === "New worktree") {
          const { basename: bn, dirname: dn } = await import("node:path");
          const repoName = bn(config.mainRepo);
          const parentDir = dn(config.mainRepo);
          const defaultPath = `${parentDir}/${repoName}-${sanitizeBranchName(name)}`;

          const wsInput = await ctx.ui.editor("Worktree path:", defaultPath);
          if (!wsInput?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }
          wsPath = wsInput.trim();
        } else if (wsChoice === "Use current directory") {
          wsPath = ctx.cwd;
        }
      }

      // ---- EXECUTE ALL ACTIONS ----

      // 1. Copy built-in role if needed
      if (roleToAdd) {
        await addRole(session, roleToAdd);
      }

      // 2. Create worktree if requested
      let workspace: string | undefined;
      if (wsChoice === "New worktree" && wsPath && config.mainRepo) {
        const branchName = `agent/${sanitizeBranchName(name)}`;
        const result = await pi.exec(
          "git", ["-C", config.mainRepo, "worktree", "add", wsPath, "-b", branchName],
          { timeout: 30000 }
        );
        if (result.code !== 0) {
          const retry = await pi.exec(
            "git", ["-C", config.mainRepo, "worktree", "add", wsPath, branchName],
            { timeout: 30000 }
          );
          if (retry.code !== 0) {
            ctx.ui.notify(`Workspace creation failed: ${retry.stderr}\nAgent created without workspace.`, "warning");
          } else {
            workspace = wsPath;
          }
        } else {
          workspace = wsPath;
        }
      } else if (wsChoice === "Use current directory") {
        workspace = wsPath;
      }

      // 3. Create agent
      const agent: AgentInfo = {
        id: newAgentId(),
        name,
        session: session,
        role: roleName ?? `Agent ${name}`,
        roleName,
        workspace,
        model: agentModel,
        cwd: workspace || ctx.cwd,
        pid: 0,
        status: "offline",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };
      try {
        await registerAgent(session, agent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(msg, "error");
        return;
      }

      let msg = `Agent "${name}" created (offline).`;
      if (roleName) msg += `\nRole: ${roleName}`;
      if (workspace) msg += `\nWorkspace: ${workspace}`;
      msg += `\nStart Pi${workspace ? " in " + workspace : ""} and /amux join.`;
      ctx.ui.notify(msg, "info");
      return;
    }

    // Selected existing agent
    const selectedName = selected.split(" (")[0]!;
    const agent = allAgents.find((a) => a.name === selectedName);
    if (!agent) return;

    if (agent.status === "online") {
      ctx.ui.notify(`Agent "${agent.name}" is online. They must /amux leave first to rename or delete.`, "warning");
      return;
    }

    const action = await ctx.ui.select(`Agent "${agent.name}":`, ["Rename", "Delete"]);
    if (!action) return;

    if (action === "Delete") {
      const confirm = await ctx.ui.confirm("Delete agent?", `Permanently delete "${agent.name}"?`);
      if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }
      await removeAgent(session, agent.id);
      ctx.ui.notify(`Deleted agent "${agent.name}".`, "info");
    } else if (action === "Rename") {
      const newName = await ctx.ui.input("New name:", agent.name);
      if (!newName || newName === agent.name) { ctx.ui.notify("Cancelled.", "info"); return; }
      try {
        await updateAgent(session, agent.id, { name: newName });
        ctx.ui.notify(`Renamed "${agent.name}" to "${newName}".`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(msg, "error");
      }
    }
  }

  async function manageRoles(ctx: ExtensionContext): Promise<void> {
    const session = await resolveProjectForManage(ctx);
    if (!session) return;

    const roles = await readRoles(session);
    const roleNames = Object.keys(roles);
    const registry = await readRegistry(session);
    const allAgents = Object.values(registry);

    const ADD_NEW = "+ New role";
    const options = [
      ...roleNames.map((name) => {
        const role = roles[name]!;
        const desc = role.description || role.instructions.slice(0, 60);
        const usedBy = allAgents.filter((a) => a.roleName === name).map((a) => a.name);
        const builtinTag = isBuiltinRole(name) ? "built-in" : "custom";
        const usageTag = usedBy.length > 0 ? `used by: ${usedBy.join(", ")}` : "unused";
        return `${name} -- ${desc} (${builtinTag}, ${usageTag})`;
      }),
      ADD_NEW,
    ];

    const choice = await ctx.ui.select("Roles:", options);
    if (!choice) return;

    if (choice === ADD_NEW) {
      const name = await ctx.ui.input("Role name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }
      const desc = await ctx.ui.input("Short description:");
      if (!desc) { ctx.ui.notify("Cancelled.", "info"); return; }
      const instructions = await ctx.ui.input("Full instructions:");
      if (!instructions) { ctx.ui.notify("Cancelled.", "info"); return; }

      await addRole(session, { name, description: desc, instructions });
      ctx.ui.notify(`Role "${name}" added.`, "info");

    } else {
      // Selected an existing role
      const selectedName = choice.split(" -- ")[0]!;
      const role = roles[selectedName];
      if (!role) return;

      const builtin = isBuiltinRole(selectedName);
      const usedBy = allAgents.filter((a) => a.roleName === selectedName).map((a) => a.name);
      const inUse = usedBy.length > 0;

      // Build action menu based on type and usage
      // Built-in: View | Edit
      // Custom (in use): View | Edit
      // Custom (unused): View | Edit | Delete
      const actions: string[] = ["View", "Edit"];
      if (!builtin && !inUse) {
        actions.push("Delete");
      }

      const action = await ctx.ui.select(`Role "${selectedName}":`, actions);
      if (!action) return;

      if (action === "View") {
        const builtinNote = builtin ? " (built-in)" : "";
        const usageNote = inUse ? `\nUsed by: ${usedBy.join(", ")}` : "\nNot in use";
        const descNote = role.description ? `\nDescription: ${role.description}` : "";
        ctx.ui.notify(
          `Role: ${selectedName}${builtinNote}${descNote}${usageNote}\n\nInstructions:\n${role.instructions}`,
          "info"
        );
      } else if (action === "Edit") {
        const newInstructions = await ctx.ui.input("Instructions:", role.instructions);
        if (!newInstructions || newInstructions === role.instructions) {
          ctx.ui.notify("No changes.", "info");
          return;
        }
        await addRole(session, { ...role, instructions: newInstructions });
        ctx.ui.notify(`Role "${selectedName}" updated.`, "info");
      } else if (action === "Delete") {
        const confirm = await ctx.ui.confirm("Delete role?", `Permanently delete role "${selectedName}"?`);
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }

        await removeRole(session, selectedName);
        ctx.ui.notify(`Role "${selectedName}" deleted.`, "info");
      }
    }
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

    let msg = `Created project "${name}".`;
    if (setRepo) msg += `\nMain repo: ${config.mainRepo}`;
    msg += `\n\nNext: /amux new agent <name> --role <role>  or  /amux manage`;
    ctx.ui.notify(msg, "info");
  }

  async function handleNewAgent(args: string[], ctx: ExtensionContext): Promise<void> {
    const { positional, flags } = parseShortcutArgs(args);

    const session = await resolveProjectForManage(ctx);
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
      ctx.ui.notify("No main repo configured. Use /amux manage > Projects to set one.", "warning");
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
    const session = await resolveProjectForManage(ctx);
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

  // -- context command ------------------------------------------

  async function handleContext(args: string[], ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    ensureArtifactDirs();
    const contextPath = join(projectArtifactsDir(), "CONTEXT.md");
    const sub = args[0] || "show";

    switch (sub) {
      case "show": {
        const content = readContextFile(projectArtifactsDir());
        if (!content) {
          ctx.ui.notify(`No project context set.\n\nUse /amux context edit  or  /amux context set <text>`, "info");
        } else {
          ctx.ui.notify(`Project context (${contextPath}):\n\n${content}`, "info");
        }
        break;
      }
      case "edit": {
        const current = readContextFile(projectArtifactsDir()) || "";
        const result = await ctx.ui.editor("Edit project context:", current);
        if (result === null || result === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
        writeFileSync(contextPath, result, "utf8");
        ctx.ui.notify("Project context updated. Changes affect future agent prompts.", "info");
        break;
      }
      case "set": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux context set <text>", "warning"); return; }
        writeFileSync(contextPath, text, "utf8");
        ctx.ui.notify("Project context set. Changes affect future agent prompts.", "info");
        break;
      }
      case "append": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /amux context append <text>", "warning"); return; }
        const current = readContextFile(projectArtifactsDir()) || "";
        writeFileSync(contextPath, current + (current ? "\n\n" : "") + text, "utf8");
        ctx.ui.notify("Appended to project context. Changes affect future agent prompts.", "info");
        break;
      }
      case "clear": {
        const confirm = await ctx.ui.confirm("Clear context?", "Remove all project context? This affects future agent prompts.");
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }
        writeFileSync(contextPath, "", "utf8");
        ctx.ui.notify("Project context cleared.", "info");
        break;
      }
      case "path": {
        ctx.ui.notify(contextPath, "info");
        break;
      }
      default:
        ctx.ui.notify(
          "Usage:\n  /amux context           Show current context\n  /amux context edit      Open editor\n  /amux context set <t>   Replace context\n  /amux context append <t>  Append to context\n  /amux context clear     Clear context\n  /amux context path      Show file path",
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

  const MAX_CONTEXT_SIZE = 4096;

  /** Read a CONTEXT.md file if it exists, with size guard. */
  function readContextFile(dir: string): string | null {
    const path = join(dir, "CONTEXT.md");
    if (!existsSync(path)) return null;
    try {
      let content = readFileSync(path, "utf8").trim();
      if (content.length > MAX_CONTEXT_SIZE) {
        content = content.slice(0, MAX_CONTEXT_SIZE) + `\n\n[truncated  -- see full file at ${path}]`;
      }
      return content || null;
    } catch {
      return null;
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
      const sessionLabel = theme.fg("dim", `[${mySession}] `);

      if (agents.length === 0) {
        ctx.ui.setStatus("amux", sessionLabel + theme.fg("dim", "no agents"));
        return;
      }

      const parts = agents.map((a) => {
        const icon = a.id === myId ? "◆" : "○";
        const color: "accent" | "success" = a.id === myId ? "accent" : "success";
        const label = [a.roleName, a.name].filter(Boolean).join(":");
        return theme.fg(color, `${icon} ${label}`);
      });

      ctx.ui.setStatus("amux", sessionLabel + parts.join(theme.fg("dim", " | ")));
    } catch {
      // Ignore widget errors
    }
  }
}
