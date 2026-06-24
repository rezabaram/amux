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
import { mkdirSync, existsSync } from "node:fs";
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
  formatAddress,
  readRoles,
  getRole,
  addRole,
  readSessionConfig,
  writeSessionConfig,
} from "../core/registry";
import {
  resolveRoleInstructions,
  getTeamTemplate,
  readRoleTemplate,
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
  gatherAgentPromptSections,
  type PromptContextAgent,
} from "../core/prompt-context";
import { allAmuxTools } from "../core/tools/index.ts";
import { registerAmuxTools, buildAmuxToolContext } from "./tool-adapter.ts";
import {
  ensureInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  watchInbox,
  formatMessageAge,
  readPendingReplies,
  type InboxMessage,
} from "../core/messaging";
import {
  checkConflict,
  clearStaleReservations,
  toWorkspaceRelative,
  formatReservationConflict,
  reservationTaskId,
} from "../core/reservations";
import {
  type BacklogItem,
  readBacklog,
  readSpecPreview,
} from "../core/backlog";
import {
  getRecentEntries,
} from "../core/journal";
import {
  readTaskComments,
} from "../core/task-comments";
import { deriveWorktreePath } from "../core/setup-service";
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
  renderTaskDetails,
  renderProgressSummary,
  renderAgentPresence,
  renderAgentWorkState,
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

  function inboxMessagePrefix(msg: InboxMessage): string {
    const age = formatMessageAge(msg.timestamp);
    const catStr = msg.category ? ` · ${msg.category}` : "";
    const taskStr = msg.taskId ? ` · ${msg.taskId}` : "";
    const responseStr = msg.responseRequired ? " · response requested" : "";
    return msg.fromRole
      ? `[amux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})${catStr}${taskStr}${responseStr} · sent ${age}]`
      : `[amux:${msg.fromSession}/${msg.fromName}${catStr}${taskStr}${responseStr} · sent ${age}]`;
  }

  function formatInboxDelivery(msg: InboxMessage): string {
    let text = `${inboxMessagePrefix(msg)} ${msg.message}`;
    if (msg.responseRequired) {
      text += `\n\nResponse requested. Reply with amux_send to ${formatAddress(msg.fromSession, msg.fromName)} and include inReplyTo: "${msg.id}".`;
    }
    return text;
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

      pi.sendUserMessage(formatInboxDelivery(msg), {
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

      pi.sendUserMessage(formatInboxDelivery(msg), {
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
   * Gather all amux coordination sections for the joined agent. Thin adapter
   * wrapper over the core gatherer: it supplies the current agent's
   * identity/role/address and the only host-execution concern (resolving the
   * git branch of the agent worktree). The product logic lives in
   * core/prompt-context.ts so the injected prompt and the `/amux prompt`
   * preview -- which share this single path -- can never drift.
   *
   * Caller must ensure the agent has joined (mySession/myId/myName set).
   */
  async function gatherPromptSections(): Promise<PromptSections> {
    const agent: PromptContextAgent = {
      session: mySession!,
      id: myId!,
      name: myName!,
      roleName: myRoleName,
      roleInstructions: myRoleInstructions,
      address: myAddress(),
    };
    return gatherAgentPromptSections(agent, {
      getWorkspaceBranch: async (workspace) => {
        const r = await pi.exec("git", ["-C", workspace, "branch", "--show-current"], { timeout: 5000 });
        return r.stdout?.trim() || "unknown";
      },
    });
  }

  // -- Tools ----------------------------------------------------

  // Neutral tool registry: schema/result bridging and registration live in
  // pi/tool-adapter.ts; tool product logic is framework-neutral in core/tools.
  // (amux_artifacts, amux_list, amux_project, and amux_wow are migrated;
  // other tools remain inline pending SPEC-18 slices 3-5.)
  registerAmuxTools(pi, allAmuxTools(), () => {
    if (!mySession || !myId || !myName) {
      throw new Error("Not registered. Use /amux new agent --join to set up, then /amux join.");
    }
    return buildAmuxToolContext({
      session: mySession,
      agentId: myId,
      agentName: myName,
      roleName: myRoleName,
      exec: pi.exec,
    });
  });

  // - Neutral-registry tools (all migrated) ---------------------
  // All amux tools (amux_artifacts, amux_list, amux_project, amux_wow,
  // amux_send, amux_broadcast, amux_discussion, amux_role, amux_reserve,
  // amux_journal, amux_task) are registered via the neutral tool registry
  // bridge (pi/tool-adapter.ts). See allAmuxTools() in core/tools; slash
  // commands remain in this Pi adapter.

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
      const plan = deriveWorktreePath(config.mainRepo, name);
      const { wsPath, branchName } = plan;

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

  // ── shared managed-artifact handler ──────────────────────────

  type ArtifactOps = {
    /** Human-readable label for messages (e.g. "project vision/context"). */
    label: string;
    /** Command path for help text (e.g. "project vision"). */
    command: string;
    /** Read the artifact preview, returning null if it does not exist. */
    read(): string | null;
    /** Read the full artifact for editing, returning null if it does not exist. */
    readFull(): string | null;
    /** Write content and return the full path. */
    write(content: string): string;
    /** Append content and return the full path. */
    append(content: string): string;
    /** Clear the artifact and return the full path. */
    clear(): string;
    /** Return the full artifact path. */
    path(): string;
  };

  async function handleManagedArtifact(
    args: string[],
    ctx: ExtensionContext,
    ops: ArtifactOps,
  ): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Not in a project. Use /amux join first.", "warning");
      return;
    }

    const sub = args[0] || "show";

    switch (sub) {
      case "show": {
        const content = ops.read();
        const p = ops.path();
        if (!content) {
          ctx.ui.notify(`No ${ops.label} set.

Use /amux ${ops.command} set <text>`, "info");
        } else {
          ctx.ui.notify(`${ops.label.charAt(0).toUpperCase() + ops.label.slice(1)} (${p}):

${content}`, "info");
        }
        break;
      }
      case "edit": {
        const current = ops.readFull() ?? "";
        const result = await ctx.ui.editor(`Edit ${ops.label}:`, current);
        if (result === null || result === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
        ops.write(result);
        ctx.ui.notify(`${ops.label.charAt(0).toUpperCase() + ops.label.slice(1)} updated. Changes affect future agent prompts.`, "info");
        break;
      }
      case "set": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify(`Usage: /amux ${ops.command} set <text>`, "warning"); return; }
        ops.write(text);
        ctx.ui.notify(`${ops.label.charAt(0).toUpperCase() + ops.label.slice(1)} set. Changes affect future agent prompts.`, "info");
        break;
      }
      case "append": {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify(`Usage: /amux ${ops.command} append <text>`, "warning"); return; }
        ops.append(text);
        ctx.ui.notify(`Appended to ${ops.label}. Changes affect future agent prompts.`, "info");
        break;
      }
      case "clear": {
        const confirm = await ctx.ui.confirm(`Clear ${ops.label}?`, `Remove all ${ops.label}? This affects future agent prompts.`);
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }
        ops.clear();
        ctx.ui.notify(`${ops.label.charAt(0).toUpperCase() + ops.label.slice(1)} cleared.`, "info");
        break;
      }
      case "path": {
        ctx.ui.notify(ops.path(), "info");
        break;
      }
      default:
        ctx.ui.notify(
          `Usage:
  /amux ${ops.command}                         Show current ${ops.label}
  /amux ${ops.command} set <t>          Replace ${ops.label}
  /amux ${ops.command} append <t>       Append to ${ops.label}
  /amux ${ops.command} edit             Open editor
  /amux ${ops.command} clear            Clear ${ops.label}
  /amux ${ops.command} path             Show path`,
          "info"
        );
    }
  }
  async function handleContext(args: string[], ctx: ExtensionContext): Promise<void> {
    return handleManagedArtifact(args, ctx, {
      label: "project vision/context",
      command: "project vision",
      read: () => readProjectContext(mySession),
      readFull: () => readProjectContext(mySession, 0),
      write: (c) => { writeProjectContext(mySession, c); return projectContextPath(mySession); },
      append: (c) => { appendProjectContext(mySession, c); return projectContextPath(mySession); },
      clear: () => clearProjectContext(mySession),
      path: () => projectContextPath(mySession),
    });
  }


  // -- wow handler --

  async function handleWow(args: string[], ctx: ExtensionContext): Promise<void> {
    return handleManagedArtifact(args, ctx, {
      label: "Ways of Working",
      command: "wow",
      read: () => readWaysOfWorking(mySession),
      readFull: () => readWaysOfWorking(mySession, 0),
      write: (c) => { writeWaysOfWorking(mySession, c); return wowPath(mySession); },
      append: (c) => { appendWaysOfWorking(mySession, c); return wowPath(mySession); },
      clear: () => { clearWaysOfWorking(mySession); return wowPath(mySession); },
      path: () => wowPath(mySession),
    });
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

  // listFiles moved to core/tools/pilot-tools.ts (neutral amux_artifacts)

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
