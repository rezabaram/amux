/**
 * E2E flow tests for amux core modules.
 *
 * Tests business logic directly — no Pi extension interface needed.
 * All core modules are pure Node with zero external dependencies.
 *
 * Run: node --test test/flows.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, mkdtempSync, mkdirSync as mkDir, writeFileSync, readFileSync as readF } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { sessionFile } from "../core/storage.ts";

import {
  readRegistry,
  registerAgent,
  removeAgent,
  updateAgent,
  goOnline,
  goOffline,
  newAgentId,
  findByName,
  findById,
  getOnlineAgents,
  getOfflineAgents,
  isEffectivelyOnline,
  shouldSignalAgent,
  shouldSignalAgentForWork,
  HEARTBEAT_TTL_MS,
  readRoles,
  addRole,
  removeRole,
  getRole,
  readSessionConfig,
  writeSessionConfig,
  parseAddress,
  type AgentInfo,
} from "../core/registry.ts";
import {
  listRoleTemplates,
  listTeamTemplates,
  readRoleTemplate,
  copyRoleProfile,
  resolveRoleInstructions,
  applyTeamTemplate,
  roleProfileFullPath,
  roleProfileRelPath,
} from "../core/roles.ts";
import {
  readWaysOfWorking,
  writeWaysOfWorking,
  appendWaysOfWorking,
  clearWaysOfWorking,
  wowPath,
} from "../core/ways-of-working.ts";
import {
  assembleAgentPrompt,
  COMMON_PRINCIPLES,
  formatPromptPreview,
  formatPromptSectionPreview,
  formatPromptSummary,
  gatheredSectionNames,
  skippedSectionNames,
  PROMPT_SECTION_ORDER,
} from "../core/prompt-assembly.ts";

import {
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  newMessageId,
  formatMessageAge,
  type InboxMessage,
} from "../core/messaging.ts";

import {
  type BacklogItem,
  readBacklog,
  addTask,
  getTask,
  updateTask,
  unmetDependencies,
  ITEM_TYPE_PREFIX,
  specRelativePath,
  specFullPath,
  defaultSpecTemplate,
  readSpecPreview,
  planTaskSpec,
} from "../core/backlog.ts";

import {
  reserve,
  release,
  checkConflict,
  clearStaleReservations,
  getReservations,
  pathsOverlap,
  toWorkspaceRelative,
  normalizePath,
  reservationTaskId,
  formatReservationAge,
  formatReservationConflict,
} from "../core/reservations.ts";

import {
  appendEntry,
  readEntries,
  getRecentEntries,
} from "../core/journal.ts";
import {
  projectContextPath,
  readProjectContext,
  writeProjectContext,
  appendProjectContext,
  clearProjectContext,
} from "../core/project-context.ts";

import {
  appendTaskComment,
  readTaskComments,
  formatTaskComment,
  resolveTaskCommentSubscribers,
  taskCommentMentions,
  taskCommentPreview,
  type TaskComment,
} from "../core/task-comments.ts";
import {
  renderTaskListRow,
  renderTaskDetails,
  renderProgressSummary,
  renderAgentWorkState,
  renderAgentPresence,
  formatDuration,
} from "../core/renderers.ts";
import {
  serviceAssignTasks,
  servicePickTask,
  serviceCompleteTask,
  serviceReviewTask,
  serviceDropTask,
  serviceBlockTask,
} from "../core/task-service.ts";

// -- Test isolation --

// Redirect all session data to a temp directory — never touches ~/.amux
const TEST_ROOT = mkdtempSync(join(tmpdir(), "amux-test-"));
process.env.AMUX_SESSIONS_DIR = TEST_ROOT;

// Clean up entire temp directory after all tests
after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function testSession(name: string): string {
  return `_test_${name}_${process.pid}`;
}

function cleanupSession(session: string): void {
  const dir = join(TEST_ROOT, session);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// -- Tests --

describe("Project lifecycle", () => {
  const session = testSession("project");
  after(() => cleanupSession(session));

  it("creates a project config", async () => {
    await writeSessionConfig(session, { createdAt: new Date().toISOString() });
    const config = await readSessionConfig(session);
    assert.ok(config.createdAt);
  });

  it("sets main repo path", async () => {
    const config = await readSessionConfig(session);
    config.mainRepo = "/home/user/myapp";
    await writeSessionConfig(session, config);
    const updated = await readSessionConfig(session);
    assert.equal(updated.mainRepo, "/home/user/myapp");
  });
});

describe("Agent lifecycle (chicken-and-egg)", () => {
  const session = testSession("agents");
  after(() => cleanupSession(session));

  it("creates agent WITHOUT joining first", async () => {
    const agent: AgentInfo = {
      id: newAgentId(),
      name: "TestAgent",
      session,
      role: "developer",
      roleName: "developer",
      cwd: "/tmp",
      pid: 0,
      status: "offline",
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };
    await registerAgent(session, agent);
    const found = await findByName(session, "TestAgent");
    assert.ok(found, "Agent should exist after creation without joining");
    assert.equal(found!.status, "offline");
  });

  it("creates multiple agents in same project", async () => {
    await registerAgent(session, {
      id: newAgentId(),
      name: "Agent2",
      session,
      role: "architect",
      cwd: "/tmp",
      pid: 0,
      status: "offline",
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });
    const registry = await readRegistry(session);
    assert.equal(Object.keys(registry).length, 2);
  });

  it("goes online and offline", async () => {
    const agent = await findByName(session, "TestAgent");
    await goOnline(session, agent!.id, 12345);
    assert.equal((await findById(session, agent!.id))!.status, "online");

    await goOffline(session, agent!.id);
    assert.equal((await findById(session, agent!.id))!.status, "offline");
  });

  it("lists online and offline agents", async () => {
    const agent = await findByName(session, "TestAgent");
    await goOnline(session, agent!.id, 12345);

    const online = await getOnlineAgents(session);
    const offline = await getOfflineAgents(session);
    assert.equal(online.length, 1);
    assert.equal(offline.length, 1);
  });

  it("removes an agent", async () => {
    const agent = await findByName(session, "Agent2");
    await removeAgent(session, agent!.id);
    assert.equal(await findByName(session, "Agent2"), null);
  });
});

describe("Role lifecycle", () => {
  const session = testSession("roles");
  after(() => cleanupSession(session));

  it("adds and gets a role", async () => {
    await addRole(session, { name: "dev", description: "Write code", instructions: "You are a dev." });
    const role = await getRole(session, "dev");
    assert.ok(role);
    assert.equal(role!.description, "Write code");
  });

  it("lists multiple roles", async () => {
    await addRole(session, { name: "arch", instructions: "You are an architect." });
    const roles = await readRoles(session);
    assert.equal(Object.keys(roles).length, 2);
  });

  it("removes a role", async () => {
    assert.ok(await removeRole(session, "arch"));
    assert.equal(await getRole(session, "arch"), null);
  });

  it("returns false removing non-existent role", async () => {
    assert.equal(await removeRole(session, "nope"), false);
  });
});

describe("Messaging (crash-safe)", () => {
  const session = testSession("msg");
  const agentId = newAgentId();
  after(() => cleanupSession(session));

  it("sends and receives a message", () => {
    ensureInbox(session, agentId);
    sendToInbox(session, agentId, {
      id: newMessageId(),
      from: "sender",
      fromName: "Sender",
      fromSession: session,
      timestamp: new Date().toISOString(),
      message: "Hello!",
    });
    const pending = getRecoverableMessages(session, agentId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.msg.message, "Hello!");
  });

  it("marks delivered for crash safety", () => {
    const pending = getRecoverableMessages(session, agentId);
    markAsDelivered(session, agentId, pending[0]!.filename);

    const recoverable = getRecoverableMessages(session, agentId);
    assert.equal(recoverable.length, 1);
    assert.ok(recoverable[0]!.filename.endsWith(".delivered"));
  });

  it("confirms and cleans up delivered", () => {
    confirmDelivered(session, agentId);
    assert.equal(getRecoverableMessages(session, agentId).length, 0);
  });
});

describe("Task backlog", () => {
  const session = testSession("tasks");
  after(() => cleanupSession(session));

  it("adds tasks with auto-incrementing IDs", async () => {
    const t1 = await addTask(session, {
      title: "First", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const t2 = await addTask(session, {
      title: "Second", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(t1.id, "TASK-01");
    assert.equal(t2.id, "TASK-02");
  });

  it("urgent prepends", async () => {
    const urgent = await addTask(session, {
      title: "Urgent", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, true);
    const backlog = await readBacklog(session);
    assert.equal(backlog[0]!.id, urgent.id);
  });

  it("updates task status", async () => {
    await updateTask(session, "TASK-01", { status: "in-progress", assignee: "Dev" });
    const task = await getTask(session, "TASK-01");
    assert.equal(task!.status, "in-progress");
  });

  it("completes with summary", async () => {
    await updateTask(session, "TASK-01", {
      status: "done", completedAt: new Date().toISOString(), summary: "Done!",
    });
    const task = await getTask(session, "TASK-01");
    assert.equal(task!.status, "done");
    assert.equal(task!.summary, "Done!");
  });
});

describe("File reservations", () => {
  const session = testSession("reserve");
  const agentA = "agent-a";
  const agentB = "agent-b";
  after(() => cleanupSession(session));

  it("reserves a path", async () => {
    await reserve(session, ["src/auth/"], agentA, "A", "auth work");
    const r = await getReservations(session);
    assert.ok(r["src/auth/"]);
  });

  it("detects conflicts", async () => {
    await assert.rejects(() => reserve(session, ["src/auth/login.ts"], agentB, "B"), /Conflict/);
  });

  it("allows same-agent nesting", async () => {
    await reserve(session, ["src/auth/login.ts"], agentA, "A");
  });

  it("checks conflict correctly", async () => {
    assert.ok(await checkConflict(session, "src/auth/login.ts", agentB));
    assert.equal(await checkConflict(session, "src/utils.ts", agentB), null);
  });

  it("releases and clears conflict", async () => {
    await release(session, ["src/auth/"], agentA);
    // login.ts is still reserved by agentA directly
    assert.ok(await checkConflict(session, "src/auth/login.ts", agentB));
    await release(session, ["src/auth/login.ts"], agentA);
    assert.equal(await checkConflict(session, "src/auth/login.ts", agentB), null);
  });

  it("formats reservation conflicts with age and task context", async () => {
    const reservation = {
      agent: "A",
      agentId: agentA,
      since: new Date(Date.now() - 120000).toISOString(),
      reason: "TASK-42: auth work",
    };
    assert.equal(reservationTaskId(reservation), "TASK-42");
    assert.equal(formatReservationAge(reservation.since), "2m");
    const text = formatReservationConflict("src/auth.ts", reservation);
    assert.ok(text.includes("src/auth.ts"));
    assert.ok(text.includes("A"));
    assert.ok(text.includes("TASK-42"));
    assert.ok(text.includes("2m"));
  });

  it("cleans stale reservations", async () => {
    await reserve(session, ["stale.ts"], agentB, "B");
    const removed = await clearStaleReservations(session, [agentA]);
    assert.ok(removed > 0);
  });
});

describe("Journal", () => {
  const session = testSession("journal");
  after(() => cleanupSession(session));

  it("appends and reads entries", () => {
    for (let i = 0; i < 15; i++) {
      appendEntry(session, {
        timestamp: new Date().toISOString(),
        agent: "Test", agentId: "id",
        type: i % 2 === 0 ? "decision" : "learning",
        content: `Entry ${i}`,
      });
    }
    assert.equal(readEntries(session).length, 15);
  });

  it("limits results", () => {
    assert.equal(readEntries(session, 5).length, 5);
  });

  it("filters by type", () => {
    const decisions = readEntries(session, undefined, "decision");
    assert.ok(decisions.every((e) => e.type === "decision"));
  });

  it("sliding window", () => {
    const window = getRecentEntries(session, 10);
    assert.equal(window.length, 10);
    assert.equal(window[0]!.content, "Entry 5");
  });
});

describe("Integration: full agent workflow", () => {
  const session = testSession("integration");
  let architectId: string;
  let developerId: string;
  after(() => cleanupSession(session));

  it("sets up project with roles and agents (no join required)", async () => {
    await writeSessionConfig(session, { createdAt: new Date().toISOString() });
    await addRole(session, { name: "architect", instructions: "Design systems." });
    await addRole(session, { name: "developer", instructions: "Write code." });

    architectId = newAgentId();
    developerId = newAgentId();

    await registerAgent(session, {
      id: architectId, name: "Alice", session, role: "architect",
      roleName: "architect", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    await registerAgent(session, {
      id: developerId, name: "Bob", session, role: "developer",
      roleName: "developer", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });

    assert.equal(Object.keys(await readRegistry(session)).length, 2);
  });

  it("architect creates and assigns task (state-driven, no inbox)", async () => {
    await goOnline(session, architectId, process.pid);

    await addTask(session, {
      title: "Add validation", status: "todo", files: ["src/auth.ts"],
      createdBy: "Alice", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Assign via task state + activity record (no inbox message)
    await updateTask(session, "TASK-01", {
      status: "assigned", assignee: "Bob", assigneeId: developerId,
    });
    appendTaskComment(session, "TASK-01", {
      timestamp: new Date().toISOString(),
      agent: "Alice", agentId: architectId,
      type: "activity",
      text: "Assigned to Bob by Alice",
    });

    const task = await getTask(session, "TASK-01");
    assert.equal(task!.status, "assigned");
    assert.equal(task!.assigneeId, developerId);
  });

  it("developer joins, sees assignment via state, picks task, reserves files", async () => {
    await goOnline(session, developerId, process.pid);

    // Assignment visible via task state (no inbox messages to process)
    const task = await getTask(session, "TASK-01");
    assert.equal(task!.status, "assigned");
    assert.equal(task!.assigneeId, developerId);

    // Pick task + reserve
    await updateTask(session, "TASK-01", {
      status: "in-progress", assignee: "Bob", assigneeId: developerId,
    });
    await reserve(session, ["src/auth.ts"], developerId, "Bob", "TASK-01");

    assert.equal((await getTask(session, "TASK-01"))!.status, "in-progress");
    assert.ok(await checkConflict(session, "src/auth.ts", architectId));
  });

  it("developer completes task and releases files", async () => {
    await updateTask(session, "TASK-01", {
      status: "done", completedAt: new Date().toISOString(), summary: "Added zod schemas",
    });
    await release(session, ["src/auth.ts"], developerId);

    assert.equal((await getTask(session, "TASK-01"))!.status, "done");
    assert.equal(await checkConflict(session, "src/auth.ts", architectId), null);
  });
});

describe("Agent-to-agent messaging", () => {
  const session = testSession("a2a-msg");
  const agentA = newAgentId();
  const agentB = newAgentId();

  after(() => cleanupSession(session));

  it("sets up inboxes for two agents", () => {
    ensureInbox(session, agentA);
    ensureInbox(session, agentB);
  });

  it("agent A sends message to agent B", () => {
    sendToInbox(session, agentB, {
      id: newMessageId(),
      from: agentA,
      fromName: "Alice",
      fromRole: "architect",
      fromSession: session,
      timestamp: new Date().toISOString(),
      message: "Can you review the auth module?",
    });

    const pending = getRecoverableMessages(session, agentB);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.msg.fromName, "Alice");
    assert.equal(pending[0]!.msg.message, "Can you review the auth module?");
  });

  it("agent B receives, marks delivered, confirms", () => {
    const pending = getRecoverableMessages(session, agentB);
    const { msg, filename } = pending[0]!;

    // Crash-safe: append to history first
    appendToHistory(session, msg);

    // Mark delivered (rename .json → .delivered)
    markAsDelivered(session, agentB, filename);

    // Still recoverable as .delivered
    const recoverable = getRecoverableMessages(session, agentB);
    assert.equal(recoverable.length, 1);
    assert.ok(recoverable[0]!.filename.endsWith(".delivered"));

    // Confirm (delete .delivered)
    confirmDelivered(session, agentB);
    assert.equal(getRecoverableMessages(session, agentB).length, 0);
  });

  it("agent B replies to agent A", () => {
    sendToInbox(session, agentA, {
      id: newMessageId(),
      from: agentB,
      fromName: "Bob",
      fromRole: "developer",
      fromSession: session,
      timestamp: new Date().toISOString(),
      message: "Reviewed — looks good, one suggestion on error handling.",
    });

    const pending = getRecoverableMessages(session, agentA);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.msg.fromName, "Bob");
    assert.ok(pending[0]!.msg.message.includes("one suggestion"));
  });

  it("handles multiple messages in sequence", () => {
    // Send 3 more messages A → B
    for (let i = 0; i < 3; i++) {
      sendToInbox(session, agentB, {
        id: newMessageId(),
        from: agentA,
        fromName: "Alice",
        fromSession: session,
        timestamp: new Date().toISOString(),
        message: `Follow-up message ${i}`,
      });
    }

    const pending = getRecoverableMessages(session, agentB);
    assert.equal(pending.length, 3);

    // Process all — mark delivered then confirm
    for (const { msg, filename } of pending) {
      appendToHistory(session, msg);
      markAsDelivered(session, agentB, filename);
    }
    confirmDelivered(session, agentB);
    assert.equal(getRecoverableMessages(session, agentB).length, 0);
  });

  it("crash recovery: undelivered .json survives", () => {
    // Send a message but DON'T mark delivered (simulate crash)
    sendToInbox(session, agentB, {
      id: newMessageId(),
      from: agentA,
      fromName: "Alice",
      fromSession: session,
      timestamp: new Date().toISOString(),
      message: "This message survives a crash",
    });

    // On "restart", recoverable picks it up as .json
    const recoverable = getRecoverableMessages(session, agentB);
    assert.equal(recoverable.length, 1);
    assert.ok(recoverable[0]!.filename.endsWith(".json"));
    assert.equal(recoverable[0]!.msg.message, "This message survives a crash");
  });

  it("crash recovery: .delivered file survives and is redelivered", () => {
    // Mark the previous message as delivered but DON'T confirm
    const pending = getRecoverableMessages(session, agentB);
    markAsDelivered(session, agentB, pending[0]!.filename);

    // On "restart", .delivered file is still recoverable
    const recoverable = getRecoverableMessages(session, agentB);
    assert.equal(recoverable.length, 1);
    assert.ok(recoverable[0]!.filename.endsWith(".delivered"));

    // Clean up
    confirmDelivered(session, agentB);
  });
});

describe("Concurrent write coordination", () => {
  const session = testSession("concurrent");
  after(() => cleanupSession(session));

  it("concurrent addTask does not lose entries", async () => {
    const N = 20;
    const promises = Array.from({ length: N }, (_, i) =>
      addTask(session, {
        title: `Task ${i}`, status: "todo", createdBy: "Test",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
    );
    const tasks = await Promise.all(promises);

    const backlog = await readBacklog(session);
    assert.equal(backlog.length, N, `Expected ${N} tasks, got ${backlog.length}`);

    // All IDs should be unique
    const ids = new Set(tasks.map((t) => t.id));
    assert.equal(ids.size, N, `Expected ${N} unique IDs, got ${ids.size}`);
  });

  it("concurrent registerAgent does not lose entries", async () => {
    const N = 20;
    const agentIds = Array.from({ length: N }, () => newAgentId());
    const promises = agentIds.map((id, i) =>
      registerAgent(session, {
        id, name: `Agent${i}`, session,
        role: "dev", cwd: "/tmp", pid: 0, status: "offline",
        registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
      })
    );
    await Promise.all(promises);

    const registry = await readRegistry(session);
    const count = Object.keys(registry).length;
    assert.equal(count, N, `Expected ${N} agents, got ${count}`);
  });

  it("concurrent reserve (non-overlapping) does not lose entries", async () => {
    const N = 15;
    const promises = Array.from({ length: N }, (_, i) =>
      reserve(session, [`file-${i}.ts`], `agent-${i}`, `Agent${i}`)
    );
    await Promise.all(promises);

    const reservations = await getReservations(session);
    const count = Object.keys(reservations).length;
    assert.equal(count, N, `Expected ${N} reservations, got ${count}`);
  });

  it("concurrent addRole does not lose entries", async () => {
    const N = 10;
    const promises = Array.from({ length: N }, (_, i) =>
      addRole(session, { name: `role-${i}`, instructions: `Role ${i} instructions` })
    );
    await Promise.all(promises);

    const roles = await readRoles(session);
    const count = Object.keys(roles).length;
    assert.equal(count, N, `Expected ${N} roles, got ${count}`);
  });
});

describe("Path overlap semantics", () => {
  it("exact file matches itself", () => {
    assert.ok(pathsOverlap("src/auth.ts", "src/auth.ts"));
  });

  it("exact file does NOT conflict with similar prefix", () => {
    // src/auth vs src/authz.ts — no trailing slash = exact file
    assert.equal(pathsOverlap("src/auth", "src/authz.ts"), false);
    assert.equal(pathsOverlap("src/authz.ts", "src/auth"), false);
  });

  it("directory prefix conflicts with files inside", () => {
    assert.ok(pathsOverlap("src/auth/", "src/auth/login.ts"));
    assert.ok(pathsOverlap("src/auth/login.ts", "src/auth/"));
  });

  it("directory prefix does NOT conflict with similar-name directories", () => {
    assert.equal(pathsOverlap("src/auth/", "src/authz/file.ts"), false);
    assert.equal(pathsOverlap("src/authz/file.ts", "src/auth/"), false);
  });

  it("nested directory prefixes overlap", () => {
    assert.ok(pathsOverlap("src/", "src/auth/"));
    assert.ok(pathsOverlap("src/auth/", "src/"));
  });

  it("directory prefix conflicts with deeper nested files", () => {
    assert.ok(pathsOverlap("src/auth/", "src/auth/utils/helper.ts"));
  });

  it("disjoint files do not conflict", () => {
    assert.equal(pathsOverlap("src/auth.ts", "src/utils.ts"), false);
  });

  it("disjoint directories do not conflict", () => {
    assert.equal(pathsOverlap("src/auth/", "src/utils/"), false);
  });
});

describe("Workspace-relative normalization", () => {
  it("strips workspace prefix from absolute paths", () => {
    assert.equal(
      toWorkspaceRelative("/Users/reza/myapp/src/auth.ts", "/Users/reza/myapp"),
      "src/auth.ts"
    );
  });

  it("returns relative paths unchanged", () => {
    assert.equal(
      toWorkspaceRelative("src/auth.ts", "/Users/reza/myapp"),
      "src/auth.ts"
    );
  });

  it("returns paths outside workspace unchanged", () => {
    assert.equal(
      toWorkspaceRelative("/other/path/file.ts", "/Users/reza/myapp"),
      "/other/path/file.ts"
    );
  });

  it("handles missing cwd gracefully", () => {
    assert.equal(toWorkspaceRelative("/abs/path/file.ts"), "/abs/path/file.ts");
    assert.equal(toWorkspaceRelative("/abs/path/file.ts", undefined), "/abs/path/file.ts");
  });

  it("handles nested subdirectories", () => {
    assert.equal(
      toWorkspaceRelative("/Users/reza/myapp/src/auth/utils/helper.ts", "/Users/reza/myapp"),
      "src/auth/utils/helper.ts"
    );
  });
});

describe("Reservation boundary semantics (integration)", () => {
  const session = testSession("path-boundary");
  after(() => cleanupSession(session));

  it("exact file reservation does not block similar-prefix file", async () => {
    await reserve(session, ["src/auth"], "agent-x", "AgentX");
    // src/authz.ts should NOT conflict
    const conflict = await checkConflict(session, "src/authz.ts", "agent-y");
    assert.equal(conflict, null);
  });

  it("directory reservation blocks files inside but not similar-prefix", async () => {
    await reserve(session, ["src/models/"], "agent-x", "AgentX");
    // Inside the directory — should conflict
    const inside = await checkConflict(session, "src/models/user.ts", "agent-y");
    assert.ok(inside, "Expected conflict for file inside reserved directory");
    // Similar prefix — should NOT conflict
    const outside = await checkConflict(session, "src/modelstore.ts", "agent-y");
    assert.equal(outside, null);
  });

  it("absolute path under workspace conflicts with relative reservation", async () => {
    // The normalizePath + toWorkspaceRelative pipeline should make this work
    const absPath = toWorkspaceRelative("/workspace/src/auth", "/workspace");
    const normalized = normalizePath(absPath);
    // Should match the reservation set earlier
    assert.equal(normalized, "src/auth");
  });
});

describe("Agent and message ID format", () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("newAgentId returns a standard v4 UUID", () => {
    const id = newAgentId();
    assert.match(id, UUID_REGEX, `Expected UUID v4, got: ${id}`);
  });

  it("newMessageId returns a standard v4 UUID", () => {
    const id = newMessageId();
    assert.match(id, UUID_REGEX, `Expected UUID v4, got: ${id}`);
  });

  it("generated IDs are unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newAgentId()));
    assert.equal(ids.size, 100, "Expected 100 unique IDs");
  });
});

describe("Agent name uniqueness", () => {
  const session = testSession("name-uniq");
  after(() => cleanupSession(session));

  it("rejects duplicate agent name on create", async () => {
    await registerAgent(session, {
      id: newAgentId(), name: "Alice", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    await assert.rejects(
      () => registerAgent(session, {
        id: newAgentId(), name: "Alice", session,
        role: "dev", cwd: "/tmp", pid: 0, status: "offline",
        registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
      }),
      /Duplicate agent name/
    );
  });

  it("rejects case-insensitive duplicates", async () => {
    await assert.rejects(
      () => registerAgent(session, {
        id: newAgentId(), name: "alice", session,
        role: "dev", cwd: "/tmp", pid: 0, status: "offline",
        registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
      }),
      /Duplicate agent name/
    );
  });

  it("allows re-registration with the same ID (update)", async () => {
    const existingAgent = await findByName(session, "Alice");
    assert.ok(existingAgent);
    await registerAgent(session, { ...existingAgent!, role: "architect" });
    const updated = await findByName(session, "Alice");
    assert.equal(updated!.role, "architect");
  });

  it("rejects duplicate name on rename via updateAgent", async () => {
    const id2 = newAgentId();
    await registerAgent(session, {
      id: id2, name: "Bob", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    await assert.rejects(
      () => updateAgent(session, id2, { name: "Alice" }),
      /Duplicate agent name/
    );
    const bob = await findById(session, id2);
    assert.equal(bob!.name, "Bob");
  });

  it("allows non-name updates without triggering uniqueness check", async () => {
    const bob = await findByName(session, "Bob");
    await updateAgent(session, bob!.id, { status: "online" });
    const updated = await findById(session, bob!.id);
    assert.equal(updated!.status, "online");
    assert.equal(updated!.name, "Bob");
  });

  it("allows renaming to a completely different name", async () => {
    const bob = await findByName(session, "Bob");
    await updateAgent(session, bob!.id, { name: "Charlie" });
    const renamed = await findById(session, bob!.id);
    assert.equal(renamed!.name, "Charlie");
  });
});

describe("Heartbeat TTL and stale agents", () => {
  const session = testSession("heartbeat");
  const freshTime = new Date().toISOString();
  const staleTime = new Date(Date.now() - HEARTBEAT_TTL_MS - 10_000).toISOString();
  let freshId: string;
  let staleId: string;
  let offlineId: string;

  after(() => cleanupSession(session));

  it("sets up agents with various heartbeat states", async () => {
    freshId = newAgentId();
    staleId = newAgentId();
    offlineId = newAgentId();

    // Online with fresh heartbeat
    await registerAgent(session, {
      id: freshId, name: "Fresh", session,
      role: "dev", cwd: "/tmp", pid: 1, status: "online",
      registeredAt: freshTime, lastHeartbeat: freshTime,
    });
    // Online but heartbeat has expired (simulates crash)
    await registerAgent(session, {
      id: staleId, name: "Stale", session,
      role: "dev", cwd: "/tmp", pid: 2, status: "online",
      registeredAt: staleTime, lastHeartbeat: staleTime,
    });
    // Explicitly offline with fresh heartbeat
    await registerAgent(session, {
      id: offlineId, name: "Offline", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: freshTime, lastHeartbeat: freshTime,
    });
  });

  it("isEffectivelyOnline is true for fresh heartbeat", async () => {
    const agent = await findById(session, freshId);
    assert.ok(isEffectivelyOnline(agent!));
  });

  it("isEffectivelyOnline is false for stale heartbeat", async () => {
    const agent = await findById(session, staleId);
    assert.equal(isEffectivelyOnline(agent!), false);
  });

  it("isEffectivelyOnline is false for offline status", async () => {
    const agent = await findById(session, offlineId);
    assert.equal(isEffectivelyOnline(agent!), false);
  });

  it("getOnlineAgents excludes stale agents", async () => {
    const online = await getOnlineAgents(session);
    assert.equal(online.length, 1);
    assert.equal(online[0]!.id, freshId);
  });

  it("getOfflineAgents includes stale agents", async () => {
    const offline = await getOfflineAgents(session);
    assert.equal(offline.length, 2);
    const ids = offline.map((a) => a.id);
    assert.ok(ids.includes(staleId), "Stale agent should appear as offline");
    assert.ok(ids.includes(offlineId), "Offline agent should appear as offline");
  });

  it("stale reservations from expired agents are cleared", async () => {
    // Stale agent holds a reservation
    await reserve(session, ["stale-file.ts"], staleId, "Stale");
    // Fresh agent holds a reservation
    await reserve(session, ["fresh-file.ts"], freshId, "Fresh");

    // Clear stale reservations using effective online list
    const online = await getOnlineAgents(session);
    const onlineIds = online.map((a) => a.id);
    const removed = await clearStaleReservations(session, onlineIds);

    assert.ok(removed >= 1, "At least 1 stale reservation should be removed");
    const remaining = await getReservations(session);
    assert.ok(remaining["fresh-file.ts"], "Fresh agent's reservation should survive");
    assert.equal(remaining["stale-file.ts"], undefined, "Stale agent's reservation should be cleared");
  });

  it("join availability treats stale agents as joinable", async () => {
    // Stale agent should appear in getOfflineAgents (joinable)
    const offline = await getOfflineAgents(session);
    const staleAgent = offline.find((a) => a.id === staleId);
    assert.ok(staleAgent, "Stale agent should be joinable (appear as offline)");
    assert.equal(staleAgent!.status, "online", "Stored status is still online");
    assert.equal(isEffectivelyOnline(staleAgent!), false, "But effectively offline");
  });
});

describe("Join flow transactional guarantees", () => {
  // The /amux join flow in pi/index.ts is refactored to be transactional:
  //
  // BEFORE (non-transactional):
  //   1. Select project
  //   2. goOffline + stopAgent + set mySession  ← state changed before validation
  //   3. Select agent  ← cancelling here left previous agent offline
  //
  // AFTER (transactional):
  //   1. Select project            ← cancel returns without state changes
  //   2. Select agent              ← cancel returns without state changes
  //   3. COMMIT: offline old → activate new  ← only after user confirms
  //
  // Manual test steps for Pi UI flow:
  //   1. Start Pi with an active amux agent (AgentA in ProjectX)
  //   2. /amux join → select a project → cancel at agent selection
  //      → Verify AgentA is still online, session unchanged
  //   3. /amux join → cancel at project selection
  //      → Verify AgentA is still online, session unchanged
  //   4. /amux join → complete both selections
  //      → Verify AgentA goes offline, new agent goes online
  //
  // Session recovery model restore:
  //   1. Join as an agent with a saved model preference
  //   2. Reload the Pi session (session_start re-fires)
  //   3. Verify the model preference is re-applied on recovery

  const session = testSession("join-txn");
  after(() => cleanupSession(session));

  it("core primitives support safe online/offline transitions", async () => {
    const id1 = newAgentId();
    const id2 = newAgentId();

    await registerAgent(session, {
      id: id1, name: "AgentA", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    await registerAgent(session, {
      id: id2, name: "AgentB", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });

    // AgentA goes online (simulates join)
    await goOnline(session, id1, process.pid);
    assert.ok(isEffectivelyOnline((await findById(session, id1))!));

    // AgentB is not affected by AgentA’s transition
    assert.equal(isEffectivelyOnline((await findById(session, id2))!), false);

    // Switch: AgentA offline, AgentB online (simulates transactional join switch)
    await goOffline(session, id1);
    await goOnline(session, id2, process.pid);
    assert.equal(isEffectivelyOnline((await findById(session, id1))!), false);
    assert.ok(isEffectivelyOnline((await findById(session, id2))!));
  });

  it("agent model preference is preserved for recovery", async () => {
    const id = newAgentId();
    const model = "anthropic/claude-sonnet-4";
    await registerAgent(session, {
      id, name: "ModelAgent", session,
      role: "dev", cwd: "/tmp", pid: 0, status: "offline",
      model,
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    // Verify model is persisted and readable for recovery
    const agent = await findById(session, id);
    assert.equal(agent!.model, model);
  });
});

describe("Task assignment semantics", () => {
  it("parseAddress detects cross-session references", () => {
    const result = parseAddress("other-session/Agent", "my-session");
    assert.equal(result.session, "other-session");
    assert.equal(result.name, "Agent");
  });

  it("parseAddress defaults to current session for bare names", () => {
    const result = parseAddress("Agent", "my-session");
    assert.equal(result.session, "my-session");
    assert.equal(result.name, "Agent");
  });

  it("explicit same-session prefix is accepted", () => {
    const result = parseAddress("my-session/Agent", "my-session");
    assert.equal(result.session, "my-session");
    assert.equal(result.name, "Agent");
  });

  // Ownership rules documented for the Pi adapter (amux_task tool).
  // Core backlog operations are data-level and do not enforce ownership;
  // ownership is enforced at the adapter layer.
  //
  // Manual verification steps:
  //
  // Cross-session assignment rejection:
  //   amux_task({ action: "assign", id: "TASK-01", to: "other-session/Agent" })
  //   → "Cross-session task assignment is not supported"
  //
  // Assignee-only operations (done/drop/block):
  //   1. Assign TASK-01 to AgentA
  //   2. As AgentB, try: amux_task({ action: "done", id: "TASK-01" })
  //      → "Only the assignee can mark it done"
  //   3. As AgentB, try: amux_task({ action: "drop", id: "TASK-01" })
  //      → "Only the assignee can drop it"
  //   4. As AgentB, try: amux_task({ action: "block", id: "TASK-01", reason: "..." })
  //      → "Only the assignee can block it"
  //   5. As AgentA, all three actions should succeed

  const session = testSession("task-own");
  after(() => cleanupSession(session));

  it("task tracks assignee through status transitions", async () => {
    const task = await addTask(session, {
      title: "Test ownership", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // Assign
    await updateTask(session, task.id, {
      status: "assigned", assignee: "AgentA", assigneeId: "agent-a",
    });
    let t = await getTask(session, task.id);
    assert.equal(t!.status, "assigned");
    assert.equal(t!.assigneeId, "agent-a");

    // Pick (in-progress)
    await updateTask(session, task.id, {
      status: "in-progress", assignee: "AgentA", assigneeId: "agent-a",
    });
    t = await getTask(session, task.id);
    assert.equal(t!.status, "in-progress");

    // Block
    await updateTask(session, task.id, {
      status: "blocked", blockedReason: "Waiting on API",
    });
    t = await getTask(session, task.id);
    assert.equal(t!.status, "blocked");
    assert.equal(t!.assigneeId, "agent-a");

    // Done
    await updateTask(session, task.id, {
      status: "done", completedAt: new Date().toISOString(), summary: "Completed",
    });
    t = await getTask(session, task.id);
    assert.equal(t!.status, "done");
    assert.equal(t!.assigneeId, "agent-a");
  });
});

describe("Task dependencies", () => {
  const session = testSession("task-deps");
  after(() => cleanupSession(session));

  let taskA: { id: string };
  let taskB: { id: string };
  let taskC: { id: string };

  it("creates tasks with dependsOn", async () => {
    const now = new Date().toISOString();
    taskA = await addTask(session, {
      title: "Foundation", status: "todo", createdBy: "Test",
      createdAt: now, updatedAt: now,
    });
    taskB = await addTask(session, {
      title: "Walls", status: "todo", dependsOn: [taskA.id], createdBy: "Test",
      createdAt: now, updatedAt: now,
    });
    taskC = await addTask(session, {
      title: "Roof", status: "todo", dependsOn: [taskA.id, taskB.id], createdBy: "Test",
      createdAt: now, updatedAt: now,
    });

    const b = await getTask(session, taskB.id);
    assert.deepStrictEqual(b!.dependsOn, [taskA.id]);
    const c = await getTask(session, taskC.id);
    assert.deepStrictEqual(c!.dependsOn, [taskA.id, taskB.id]);
  });

  it("unmetDependencies returns unmet dep IDs", async () => {
    const tasks = await readBacklog(session);
    const b = tasks.find((t) => t.id === taskB.id)!;
    const c = tasks.find((t) => t.id === taskC.id)!;

    // A is todo → B and C both have unmet deps
    assert.deepStrictEqual(unmetDependencies(b, tasks), [taskA.id]);
    assert.deepStrictEqual(unmetDependencies(c, tasks), [taskA.id, taskB.id]);
  });

  it("tasks without dependsOn have no unmet dependencies", async () => {
    const tasks = await readBacklog(session);
    const a = tasks.find((t) => t.id === taskA.id)!;
    assert.deepStrictEqual(unmetDependencies(a, tasks), []);
  });

  it("completing a dependency satisfies downstream tasks", async () => {
    // Complete task A
    await updateTask(session, taskA.id, {
      status: "done", completedAt: new Date().toISOString(),
    });

    const tasks = await readBacklog(session);
    const b = tasks.find((t) => t.id === taskB.id)!;
    const c = tasks.find((t) => t.id === taskC.id)!;

    // B’s dependency (A) is now done
    assert.deepStrictEqual(unmetDependencies(b, tasks), []);
    // C still waits on B
    assert.deepStrictEqual(unmetDependencies(c, tasks), [taskB.id]);
  });

  it("all dependencies met when entire chain is done", async () => {
    await updateTask(session, taskB.id, {
      status: "done", completedAt: new Date().toISOString(),
    });

    const tasks = await readBacklog(session);
    const c = tasks.find((t) => t.id === taskC.id)!;
    assert.deepStrictEqual(unmetDependencies(c, tasks), []);
  });

  it("existing tasks without dependsOn are valid", async () => {
    const existing = await addTask(session, {
      title: "Existing task", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const t = await getTask(session, existing.id);
    assert.equal(t!.dependsOn, undefined);
    const tasks = await readBacklog(session);
    assert.deepStrictEqual(unmetDependencies(t!, tasks), []);
  });
});

describe("Project context (CONTEXT.md)", () => {
  const session = testSession("context");
  after(() => cleanupSession(session));

  it("reads null when no context file exists", () => {
    const ctxPath = projectContextPath(session);
    assert.equal(existsSync(ctxPath), false);
    assert.equal(readProjectContext(session), null);
  });

  it("writes and reads context file through core helpers", () => {
    const content = "This project builds a multi-agent coordination system.";
    const ctxPath = writeProjectContext(session, content);

    assert.equal(ctxPath, projectContextPath(session));
    assert.equal(readProjectContext(session), content);
  });

  it("append preserves existing content", () => {
    appendProjectContext(session, "Focus on test coverage this sprint.");

    const read = readProjectContext(session) || "";
    assert.ok(read.includes("multi-agent"));
    assert.ok(read.includes("test coverage"));
  });

  it("clear writes empty content", () => {
    clearProjectContext(session);
    assert.equal(readProjectContext(session), null);
    assert.equal(readF(projectContextPath(session), "utf8").trim(), "");
  });

  it("context path is under session artifacts/project", () => {
    const ctxPath = projectContextPath(session);
    assert.ok(ctxPath.includes(session));
    assert.ok(ctxPath.endsWith("artifacts/project/CONTEXT.md"));
  });

  // Manual test steps for Pi command shortcuts:
  //
  // /amux project vision:
  //   1. /amux join → join a project
  //   2. /amux project → shows "No project context set"
  //   3. /amux project vision set "Build a REST API with auth" → "Project context set"
  //   4. /amux project → shows the set context
  //   5. /amux project vision append "Use PostgreSQL for storage" → "Appended"
  //   6. /amux project → shows both lines
  //   7. /amux project vision edit → opens editor with current content
  //   8. /amux project vision path → prints file path
  //   9. /amux project vision clear → confirms and clears
  //
  // /amux new:
  //   1. /amux new project testproj → creates project, asks about repo
  //   2. /amux new agent Dev --role developer → creates agent with role
  //   3. /amux new role custom → prompts for description and instructions
  //   4. /amux new → shows usage help
  //   5. /amux new agent → prompts for name, then role selection
});

describe("Task-scoped comments", () => {
  const session = testSession("task-comments");
  after(() => cleanupSession(session));

  it("returns empty array for task with no comments", () => {
    const comments = readTaskComments(session, "TASK-99");
    assert.deepStrictEqual(comments, []);
  });

  it("appends and reads a comment", () => {
    appendTaskComment(session, "TASK-01", {
      timestamp: "2026-06-20T10:00:00.000Z",
      agent: "Alice",
      agentId: "agent-a",
      type: "comment",
      text: "Looks good, one suggestion on error handling.",
    });

    const comments = readTaskComments(session, "TASK-01");
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.type, "comment");
    assert.equal(comments[0]!.agent, "Alice");
    assert.ok(comments[0]!.text.includes("error handling"));
  });

  it("appends activity entries alongside comments", () => {
    appendTaskComment(session, "TASK-01", {
      timestamp: "2026-06-20T10:01:00.000Z",
      agent: "Bob",
      agentId: "agent-b",
      type: "activity",
      text: "Picked by Bob",
    });
    appendTaskComment(session, "TASK-01", {
      timestamp: "2026-06-20T10:02:00.000Z",
      agent: "Bob",
      agentId: "agent-b",
      type: "comment",
      text: "Starting implementation now.",
    });

    const comments = readTaskComments(session, "TASK-01");
    assert.equal(comments.length, 3);
    assert.equal(comments[0]!.type, "comment");
    assert.equal(comments[1]!.type, "activity");
    assert.equal(comments[2]!.type, "comment");
  });

  it("isolates comments per task ID", () => {
    appendTaskComment(session, "TASK-02", {
      timestamp: "2026-06-20T11:00:00.000Z",
      agent: "Alice",
      agentId: "agent-a",
      type: "comment",
      text: "Different task discussion.",
    });

    assert.equal(readTaskComments(session, "TASK-01").length, 3);
    assert.equal(readTaskComments(session, "TASK-02").length, 1);
  });

  it("formats comments for display", () => {
    const entry: TaskComment = {
      timestamp: "2026-06-20T14:30:00.000Z",
      agent: "Alice",
      agentId: "agent-a",
      type: "comment",
      text: "Ship it!",
    };
    const formatted = formatTaskComment(entry);
    assert.ok(formatted.includes("2026-06-20 14:30"));
    assert.ok(formatted.includes("Alice"));
    assert.ok(formatted.includes("comment"));
    assert.ok(formatted.includes("Ship it!"));
  });

  it("does not affect backlog.json", async () => {
    // Create a task, add comments, verify backlog is unaffected
    const task = await addTask(session, {
      title: "Test comment isolation", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    appendTaskComment(session, task.id, {
      timestamp: new Date().toISOString(),
      agent: "Test",
      agentId: "test-id",
      type: "comment",
      text: "This should not appear in backlog.json",
    });

    const t = await getTask(session, task.id);
    assert.equal(t!.title, "Test comment isolation");
    assert.equal((t as any).comments, undefined);
  });

  it("builds compact previews and extracts mentions", () => {
    assert.equal(taskCommentPreview("Confirmed\nproceed\tnow"), "Confirmed proceed now");
    assert.equal(taskCommentPreview("x".repeat(12), 8), "xxxxxxx…");
    assert.deepEqual(taskCommentMentions("cc @Dev_1 and @Reviewer-2"), ["Dev_1", "Reviewer-2"]);
  });

  it("resolves task comment subscribers from assignee, creator, commenters, and mentions", () => {
    const now = new Date().toISOString();
    const agents: AgentInfo[] = [
      { id: "lead", name: "Lead", session, role: "lead", cwd: "/tmp", pid: 1, status: "online", registeredAt: now, lastHeartbeat: now },
      { id: "dev", name: "Developer", session, role: "dev", cwd: "/tmp", pid: 2, status: "online", registeredAt: now, lastHeartbeat: now },
      { id: "reviewer", name: "Reviewer", session, role: "reviewer", cwd: "/tmp", pid: 3, status: "offline", registeredAt: now, lastHeartbeat: now },
      { id: "author", name: "Author", session, role: "dev", cwd: "/tmp", pid: 4, status: "online", registeredAt: now, lastHeartbeat: now },
    ];
    const task = {
      id: "TASK-01", title: "Notify", status: "assigned", createdBy: "Lead",
      assigneeId: "dev", assignee: "Developer", createdAt: now, updatedAt: now,
    } as BacklogItem;
    const previous: TaskComment[] = [{ timestamp: now, agent: "Reviewer", agentId: "reviewer", type: "comment", text: "Please confirm." }];

    const subscribers = resolveTaskCommentSubscribers(task, previous, agents, "author", "Confirmed @Reviewer @Author");
    assert.deepEqual(subscribers.map((a) => a.name), ["Developer", "Lead", "Reviewer"]);
  });
});

describe("Agent availability and attention signals", () => {
  const session = testSession("availability");
  const freshTime = new Date().toISOString();
  after(() => cleanupSession(session));

  let agentId: string;

  it("creates an agent with availability", async () => {
    agentId = newAgentId();
    await registerAgent(session, {
      id: agentId, name: "Avail", session,
      role: "dev", cwd: "/tmp", pid: 1, status: "online",
      availability: "idle",
      registeredAt: freshTime, lastHeartbeat: freshTime,
    });
    const agent = await findById(session, agentId);
    assert.equal(agent!.availability, "idle");
  });

  it("shouldSignalAgent is true for idle online agent", async () => {
    const agent = await findById(session, agentId);
    assert.ok(shouldSignalAgent(agent!));
  });

  it("shouldSignalAgent is false for working agent", async () => {
    await updateAgent(session, agentId, { availability: "working" });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgent(agent!), false);
  });

  it("shouldSignalAgentForWork treats stale working as signalable when no active work", async () => {
    await updateAgent(session, agentId, { availability: "working", attentionPending: false });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgentForWork(agent!, true), false);
    assert.equal(shouldSignalAgentForWork(agent!, false), true);
  });

  it("shouldSignalAgentForWork still respects focus, away, and pending attention", async () => {
    await updateAgent(session, agentId, { availability: "focus", attentionPending: false });
    let agent = await findById(session, agentId);
    assert.equal(shouldSignalAgentForWork(agent!, false), false);

    await updateAgent(session, agentId, { availability: "away", attentionPending: false });
    agent = await findById(session, agentId);
    assert.equal(shouldSignalAgentForWork(agent!, false), false);

    await updateAgent(session, agentId, { availability: "working", attentionPending: true });
    agent = await findById(session, agentId);
    assert.equal(shouldSignalAgentForWork(agent!, false), false);
  });

  it("shouldSignalAgent is false for focus agent", async () => {
    await updateAgent(session, agentId, { availability: "focus" });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgent(agent!), false);
  });

  it("shouldSignalAgent is false for away agent", async () => {
    await updateAgent(session, agentId, { availability: "away" });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgent(agent!), false);
  });

  it("shouldSignalAgent is false when attentionPending", async () => {
    await updateAgent(session, agentId, { availability: "idle", attentionPending: true });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgent(agent!), false);
  });

  it("shouldSignalAgent is true after clearing attentionPending", async () => {
    await updateAgent(session, agentId, { attentionPending: false });
    const agent = await findById(session, agentId);
    assert.ok(shouldSignalAgent(agent!));
  });

  it("shouldSignalAgent is false for offline agents", async () => {
    await updateAgent(session, agentId, { status: "offline" });
    const agent = await findById(session, agentId);
    assert.equal(shouldSignalAgent(agent!), false);
  });

  it("preserves focus/away through task lifecycle updates", async () => {
    // If agent is focus, auto-updates should not override to idle
    await updateAgent(session, agentId, { status: "online", availability: "focus" });
    const agent = await findById(session, agentId);
    assert.equal(agent!.availability, "focus");
    // In the Pi adapter, done/drop only sets idle if availability is working or unset
    // This test documents the invariant at the core level
  });
});

describe("BacklogItem itemType", () => {
  const session = testSession("item-type");
  after(() => cleanupSession(session));

  it("creates items with explicit itemType", async () => {
    const bug = await addTask(session, {
      title: "Fix login crash", status: "todo", itemType: "bug",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(bug.itemType, "bug");

    const spec = await addTask(session, {
      title: "Auth spec", status: "todo", itemType: "spec",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(spec.itemType, "spec");
  });

  it("items without itemType default to task semantics", async () => {
    const task = await addTask(session, {
      title: "Normal task", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(task.itemType, undefined);
    // Undefined itemType is treated as "task" — no behavior difference
  });

  it("itemType persists in backlog and can be read back", async () => {
    const backlog = await readBacklog(session);
    const bug = backlog.find((t) => t.title === "Fix login crash");
    const spec = backlog.find((t) => t.title === "Auth spec");
    const normal = backlog.find((t) => t.title === "Normal task");

    assert.equal(bug!.itemType, "bug");
    assert.equal(spec!.itemType, "spec");
    assert.equal(normal!.itemType, undefined);
  });

  it("typed items support all standard operations", async () => {
    const backlog = await readBacklog(session);
    const bug = backlog.find((t) => t.title === "Fix login crash")!;

    // Update, dependency check, etc. all work on typed items
    await updateTask(session, bug.id, { status: "in-progress", assignee: "Dev" });
    const updated = await getTask(session, bug.id);
    assert.equal(updated!.status, "in-progress");
    assert.equal(updated!.itemType, "bug");
  });
});

describe("BacklogItem hierarchy fields", () => {
  const session = testSession("hierarchy");
  after(() => cleanupSession(session));

  let parentId: string;

  it("creates a parent item", async () => {
    const parent = await addTask(session, {
      title: "Epic: Auth system", status: "todo", itemType: "initiative",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    parentId = parent.id;
    assert.equal(parent.parentId, undefined);
  });

  it("creates child items with parentId and order", async () => {
    const child1 = await addTask(session, {
      title: "Login flow", status: "todo", parentId,
      order: 1,
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const child2 = await addTask(session, {
      title: "Signup flow", status: "todo", parentId,
      order: 2,
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(child1.parentId, parentId);
    assert.equal(child1.order, 1);
    assert.equal(child2.parentId, parentId);
    assert.equal(child2.order, 2);
  });

  it("parentId and order persist in backlog", async () => {
    const backlog = await readBacklog(session);
    const children = backlog.filter((t) => t.parentId === parentId);
    assert.equal(children.length, 2);
    assert.equal(children[0]!.order, 1);
    assert.equal(children[1]!.order, 2);
  });

  it("items without parentId/order remain valid", async () => {
    const standalone = await addTask(session, {
      title: "Standalone task", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(standalone.parentId, undefined);
    assert.equal(standalone.order, undefined);
  });
});

describe("Progress summary data patterns", () => {
  const session = testSession("progress");
  after(() => cleanupSession(session));

  it("supports all status categories for progress view", async () => {
    const now = new Date().toISOString();
    const base = { createdBy: "Test", createdAt: now, updatedAt: now };

    await addTask(session, { title: "Done task", status: "todo", ...base });
    await updateTask(session, "TASK-01", { status: "done", completedAt: now, summary: "Shipped" });
    await addTask(session, { title: "Active task", status: "todo", ...base });
    await updateTask(session, "TASK-02", { status: "in-progress", assignee: "Alice" });
    await addTask(session, { title: "Blocked task", status: "todo", ...base });
    await updateTask(session, "TASK-03", { status: "blocked", blockedReason: "Waiting on API" });
    await addTask(session, { title: "Review task", status: "todo", ...base });
    await updateTask(session, "TASK-04", { status: "review", assignee: "Bob" });
    await addTask(session, { title: "Todo task", status: "todo", ...base });
    await addTask(session, { title: "Dep-blocked", status: "todo", dependsOn: ["TASK-02"], ...base });

    const tasks = await readBacklog(session);
    const done = tasks.filter((t) => t.status === "done");
    const active = tasks.filter((t) => t.status === "in-progress");
    const blocked = tasks.filter((t) => t.status === "blocked");
    const review = tasks.filter((t) => t.status === "review");
    const next = tasks.filter((t) => t.status === "todo" && unmetDependencies(t, tasks).length === 0);

    assert.equal(done.length, 1);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.assignee, "Alice");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.blockedReason, "Waiting on API");
    assert.equal(review.length, 1);
    assert.equal(review[0]!.assignee, "Bob");
    assert.equal(next.length, 1, "Dep-blocked item should be excluded from next");
    assert.equal(next[0]!.title, "Todo task");
  });

  // Manual test for /amux progress:
  //   1. /amux join a project with mixed backlog
  //   2. /amux progress → see status counts, active, review, blocked, next, done
  //   3. amux_task({ action: "summary" }) → same compact view
  //   4. Verify parent items show with indented children and [N/M] counts
  //
  // Manual test for parentId validation fix:
  //   amux_task({ action: "add", title: "Child", parentId: "TASK-01" })
  //   → should succeed if TASK-01 exists (previously threw getTask is not defined)
  //   amux_task({ action: "add", title: "Child", parentId: "NONEXISTENT" })
  //   → should fail with "Parent item NONEXISTENT not found"

  it("parent/child grouping supports hierarchical progress rendering", async () => {
    const session = testSession("hier-progress");
    const now = new Date().toISOString();
    const base = { createdBy: "Test", createdAt: now, updatedAt: now };

    // Create parent initiative
    const parent = await addTask(session, {
      title: "Auth system", status: "todo", itemType: "initiative", ...base,
    });
    // Create ordered children
    await addTask(session, { title: "Login", status: "todo", parentId: parent.id, order: 1, ...base });
    await addTask(session, { title: "Signup", status: "todo", parentId: parent.id, order: 2, ...base });
    await addTask(session, { title: "OAuth", status: "todo", parentId: parent.id, order: 3, ...base });
    // Complete one child
    await updateTask(session, "TASK-02", { status: "done", completedAt: now });

    const tasks = await readBacklog(session);

    // Children grouping
    const children = tasks
      .filter((t) => t.parentId === parent.id)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    assert.equal(children.length, 3);
    assert.equal(children[0]!.title, "Login");
    assert.equal(children[2]!.title, "OAuth");

    // Progress counts
    const childDone = children.filter((c) => c.status === "done").length;
    assert.equal(childDone, 1);
    assert.equal(`[${childDone}/${children.length}]`, "[1/3]");

    // Standalone items not affected
    const topLevel = tasks.filter((t) => !t.parentId);
    assert.equal(topLevel.length, 1);
    assert.equal(topLevel[0]!.itemType, "initiative");

    cleanupSession(session);
  });
});

describe("Type-prefixed item IDs", () => {
  const session = testSession("id-prefix");
  after(() => cleanupSession(session));

  it("default items get TASK-XX IDs", async () => {
    const t = await addTask(session, {
      title: "Regular task", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.match(t.id, /^TASK-\d+$/);
  });

  it("bug items get BUG-XX IDs", async () => {
    const t = await addTask(session, {
      title: "Fix crash", status: "todo", itemType: "bug",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.match(t.id, /^BUG-\d+$/);
  });

  it("initiative items get INIT-XX IDs", async () => {
    const t = await addTask(session, {
      title: "Auth epic", status: "todo", itemType: "initiative",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.match(t.id, /^INIT-\d+$/);
  });

  it("each prefix has independent numbering", async () => {
    const backlog = await readBacklog(session);
    const task = backlog.find((t) => t.id.startsWith("TASK-"));
    const bug = backlog.find((t) => t.id.startsWith("BUG-"));
    const init = backlog.find((t) => t.id.startsWith("INIT-"));
    assert.equal(task!.id, "TASK-01");
    assert.equal(bug!.id, "BUG-01");
    assert.equal(init!.id, "INIT-01");
  });

  it("ITEM_TYPE_PREFIX maps all item types", () => {
    assert.equal(ITEM_TYPE_PREFIX["task"], "TASK");
    assert.equal(ITEM_TYPE_PREFIX["bug"], "BUG");
    assert.equal(ITEM_TYPE_PREFIX["initiative"], "INIT");
    assert.equal(ITEM_TYPE_PREFIX["milestone"], "MS");
    assert.equal(ITEM_TYPE_PREFIX["chore"], "CHORE");
    assert.equal(ITEM_TYPE_PREFIX["spec"], "SPEC");
  });
});

describe("Task spec helpers", () => {
  const session = testSession("spec-helpers");
  after(() => cleanupSession(session));

  it("specRelativePath returns conventional path format", () => {
    assert.equal(specRelativePath("TASK-01"), "tasks/TASK-01.md");
    assert.equal(specRelativePath("BUG-03"), "tasks/BUG-03.md");
  });

  it("specFullPath resolves to session artifacts directory", () => {
    const full = specFullPath(session, "tasks/TASK-01.md");
    assert.ok(full.includes(session));
    assert.ok(full.endsWith("artifacts/project/tasks/TASK-01.md"));
  });

  it("specFullPath rejects paths outside project artifacts", () => {
    assert.throws(() => specFullPath(session, "../backlog.json"), /Invalid spec path/);
    assert.throws(() => specFullPath(session, "/tmp/spec.md"), /Invalid spec path/);
    assert.equal(readSpecPreview(session, "../backlog.json"), null);
  });

  it("defaultSpecTemplate includes item details", async () => {
    const item = await addTask(session, {
      title: "Build login", status: "todo", itemType: "bug",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const tmpl = defaultSpecTemplate(item);
    assert.ok(tmpl.includes(item.id));
    assert.ok(tmpl.includes("Build login"));
    assert.ok(tmpl.includes("(bug)"));
    assert.ok(tmpl.includes("## Objective"));
    assert.ok(tmpl.includes("## Acceptance Criteria"));
  });

  it("readSpecPreview returns null for non-existent file", () => {
    assert.equal(readSpecPreview(session, "tasks/NONEXISTENT.md"), null);
  });

  it("readSpecPreview reads file content", () => {
    const relPath = specRelativePath("TASK-99");
    const fullPath = specFullPath(session, relPath);
    const dir = fullPath.replace(/\/[^/]+$/, "");
    mkDir(dir, { recursive: true });
    writeFileSync(fullPath, "# Test Spec\n\nSome content.", "utf8");

    const preview = readSpecPreview(session, relPath);
    assert.ok(preview);
    assert.ok(preview!.includes("Test Spec"));
    assert.ok(preview!.includes("Some content"));
  });

  it("readSpecPreview truncates large content", () => {
    const relPath = specRelativePath("TASK-BIG");
    const fullPath = specFullPath(session, relPath);
    writeFileSync(fullPath, "x".repeat(5000), "utf8");

    const preview = readSpecPreview(session, relPath, 100);
    assert.ok(preview);
    assert.ok(preview!.length < 200);
    assert.ok(preview!.includes("[truncated]"));
  });

  it("specPath persists on BacklogItem", async () => {
    const item = await addTask(session, {
      title: "With spec", status: "todo",
      specPath: specRelativePath("TASK-42"),
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(item.specPath, "tasks/TASK-42.md");
    const read = await getTask(session, item.id);
    assert.equal(read!.specPath, "tasks/TASK-42.md");
  });

  it("planTaskSpec creates a default spec and links specPath", async () => {
    const item = await addTask(session, {
      title: "Needs a plan", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await planTaskSpec(session, item);

    assert.equal(result.specPath, specRelativePath(item.id));
    assert.equal(result.created, true);
    assert.equal(result.linked, true);
    assert.ok(existsSync(result.fullPath));
    assert.ok(readF(result.fullPath, "utf8").includes("Needs a plan"));
    const updated = await getTask(session, item.id);
    assert.equal(updated!.specPath, result.specPath);
  });

  it("planTaskSpec preserves existing specs when no content is provided", async () => {
    const item = await addTask(session, {
      title: "Preserve plan", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const first = await planTaskSpec(session, item, "# Custom\n");
    const updated = await getTask(session, item.id);

    const second = await planTaskSpec(session, updated!);

    assert.equal(second.created, false);
    assert.equal(readF(first.fullPath, "utf8"), "# Custom\n");
  });

  it("planTaskSpec updates existing specs with provided content", async () => {
    const item = await addTask(session, {
      title: "Update plan", status: "todo",
      createdBy: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const first = await planTaskSpec(session, item);
    const updated = await getTask(session, item.id);

    const second = await planTaskSpec(session, updated!, "# Updated\n");

    assert.equal(second.fullPath, first.fullPath);
    assert.equal(second.updated, true);
    assert.equal(readF(second.fullPath, "utf8"), "# Updated\n");
  });

  // Manual test for plan/edit-plan actions:
  //   1. amux_task({ action: "plan", id: "TASK-01" })
  //      → creates tasks/TASK-01.md with default template, links specPath
  //   2. amux_task({ action: "plan", id: "TASK-01", content: "# Custom" })
  //      → updates spec content
  //   3. amux_task({ action: "edit-plan", id: "TASK-01" })
  //      → returns path for read/edit tools; creates if missing
  //   4. amux_task({ action: "show", id: "TASK-01" })
  //      → shows parent context + spec preview
});

describe("Auto-pick prefers assigned-to-self", () => {
  const session = testSession("auto-pick");
  const myId = "agent-me";
  after(() => cleanupSession(session));

  it("prefers assigned-to-self over open todo", async () => {
    const now = new Date().toISOString();
    const base = { createdBy: "Test", createdAt: now, updatedAt: now };

    // Create open todo and assigned-to-self tasks
    await addTask(session, { title: "Open todo", status: "todo", ...base });
    const assigned = await addTask(session, { title: "Assigned to me", status: "todo", ...base });
    await updateTask(session, assigned.id, { status: "assigned", assignee: "Me", assigneeId: myId });

    const tasks = await readBacklog(session);

    // Same logic as Pi adapter auto-pick
    const pick = tasks.find((t) => t.status === "assigned" && t.assigneeId === myId && unmetDependencies(t, tasks).length === 0)
      || tasks.find((t) => t.status === "todo" && unmetDependencies(t, tasks).length === 0);

    assert.ok(pick);
    assert.equal(pick!.title, "Assigned to me");
  });

  it("falls back to open todo when no assigned-to-self", async () => {
    const tasks = await readBacklog(session);
    // Mark the assigned task as done
    const assigned = tasks.find((t) => t.status === "assigned")!;
    await updateTask(session, assigned.id, { status: "done", completedAt: new Date().toISOString() });

    const updated = await readBacklog(session);
    const pick = updated.find((t) => t.status === "assigned" && t.assigneeId === myId && unmetDependencies(t, updated).length === 0)
      || updated.find((t) => t.status === "todo" && unmetDependencies(t, updated).length === 0);

    assert.ok(pick);
    assert.equal(pick!.title, "Open todo");
  });
});

describe("Renderer functions", () => {
  const now = new Date().toISOString();
  const baseItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
    id: "TASK-01", title: "Test task", status: "todo",
    createdBy: "Test", createdAt: now, updatedAt: now,
    ...overrides,
  } as BacklogItem);

  it("formatDuration handles various ranges", () => {
    assert.equal(formatDuration(5000), "5s");
    assert.equal(formatDuration(90000), "1m");
    assert.equal(formatDuration(3600000), "1h");
    assert.ok(formatDuration(90000000).includes("d") || formatDuration(90000000).includes("h"));
  });

  it("renderTaskListRow shows status and title", () => {
    const row = renderTaskListRow(baseItem(), [], 1);
    assert.ok(row.includes("TASK-01"));
    assert.ok(row.includes("[todo]"));
    assert.ok(row.includes("Test task"));
  });

  it("renderTaskListRow shows type label for non-task", () => {
    const row = renderTaskListRow(baseItem({ itemType: "bug" }), [], 1);
    assert.ok(row.includes("(bug)"));
  });

  it("renderTaskListRow shows spec marker", () => {
    const row = renderTaskListRow(baseItem({ specPath: "tasks/TASK-01.md" }), [], 1);
    assert.ok(row.includes("[spec]"));
  });

  it("renderTaskListRow shows assignee", () => {
    const row = renderTaskListRow(baseItem({ status: "in-progress", assignee: "Alice" }), [], 1);
    assert.ok(row.includes("Alice"));
  });

  it("renderAgentWorkState derives active and assigned work", () => {
    const tasks = [
      baseItem({ id: "TASK-01", status: "assigned", assigneeId: "a1" }),
      baseItem({ id: "TASK-02", status: "in-progress", assigneeId: "a1" }),
    ];
    assert.equal(renderAgentWorkState("a1", tasks), "working: TASK-02: Test task");
    assert.equal(renderAgentWorkState("missing", tasks), null);
  });

  it("renderAgentPresence shows active task", () => {
    const tasks = [baseItem({ id: "TASK-02", status: "in-progress", assigneeId: "a1" })];
    const row = renderAgentPresence(
      { id: "a1", name: "Alice", roleName: "developer", status: "online", availability: "working", cwd: "/repo" },
      tasks,
      { currentAgentId: "a1", includeCwd: true },
    );
    assert.ok(row.includes("Alice (you)"));
    assert.ok(row.includes("working: TASK-02: Test task"));
    assert.ok(row.includes("developer"));
    assert.ok(row.includes("/repo"));
  });

  it("renderAgentPresence shows assigned work when idle", () => {
    const tasks = [baseItem({ id: "TASK-03", status: "assigned", assigneeId: "a1" })];
    const row = renderAgentPresence(
      { id: "a1", name: "Alice", roleName: "developer", status: "online", availability: "idle" },
      tasks,
    );
    assert.ok(row.includes("assigned: TASK-03: Test task"));
  });

  it("renderTaskDetails includes all metadata", () => {
    const task = baseItem({
      description: "Build the thing",
      assignee: "Alice", assigneeId: "a1",
      files: ["src/auth.ts"],
      status: "in-progress",
    });
    const text = renderTaskDetails(task, [task], { currentAgentId: "a1" });
    assert.ok(text.includes("TASK-01"));
    assert.ok(text.includes("Build the thing"));
    assert.ok(text.includes("Alice"));
    assert.ok(text.includes("(you)"));
    assert.ok(text.includes("src/auth.ts"));
  });

  it("renderTaskDetails shows parent context", () => {
    const parent = baseItem({ id: "INIT-01", title: "Auth system", itemType: "initiative" });
    const child = baseItem({ id: "TASK-02", title: "Login", parentId: "INIT-01" });
    const text = renderTaskDetails(child, [parent, child]);
    assert.ok(text.includes("Parent: INIT-01: Auth system"));
  });

  it("renderTaskDetails shows comments", () => {
    const comments: TaskComment[] = [{
      timestamp: now, agent: "Alice", agentId: "a1",
      type: "comment", text: "Looks good!",
    }];
    const text = renderTaskDetails(baseItem(), [], { comments });
    assert.ok(text.includes("Comments (1)"));
    assert.ok(text.includes("Looks good!"));
  });

  it("renderTaskDetails shows review handoff guidance", () => {
    const task = baseItem({
      status: "review",
      specPath: "tasks/TASK-01.md",
      summary: "Commit abc123. Diff: auth parser. Tests: npm test.",
    });
    const text = renderTaskDetails(task, [], { specPreview: "## Acceptance\nPass tests" });
    assert.ok(text.includes("Review handoff"));
    assert.ok(text.includes("Commit abc123"));
    assert.ok(text.includes("Reviewer workflow"));
    assert.ok(text.includes("Spec: tasks/TASK-01.md"));
    assert.ok(text.includes("Pass tests"));
  });

  it("renderTaskDetails shows spec preview", () => {
    const task = baseItem({ specPath: "tasks/TASK-01.md" });
    const text = renderTaskDetails(task, [], { specPreview: "## Objective\nBuild auth" });
    assert.ok(text.includes("Spec: tasks/TASK-01.md"));
    assert.ok(text.includes("Build auth"));
  });

  it("renderProgressSummary handles empty backlog", () => {
    const out = renderProgressSummary("test", []);
    assert.ok(out.includes("No backlog items yet"));
  });

  it("renderProgressSummary shows flat backlog with markers", () => {
    const tasks = [
      baseItem({ id: "TASK-01", title: "Done", status: "done", completedAt: now }),
      baseItem({ id: "TASK-02", title: "Active", status: "in-progress", assignee: "Alice" }),
      baseItem({ id: "TASK-03", title: "Todo", status: "todo" }),
      baseItem({ id: "TASK-04", title: "Needs review", status: "review", assignee: "Bob" }),
    ];
    const out = renderProgressSummary("test", tasks);
    assert.ok(out.includes("1 todo"));
    assert.ok(out.includes("1 in-progress"));
    assert.ok(out.includes("1 review"));
    assert.ok(out.includes("1 done"));
    assert.ok(out.includes("TASK-02"));
    assert.ok(out.includes("Alice"));
  });

  it("renderProgressSummary shows hierarchical view", () => {
    const tasks = [
      baseItem({ id: "INIT-01", title: "Auth", itemType: "initiative" }),
      baseItem({ id: "TASK-01", title: "Login", status: "done", parentId: "INIT-01", order: 1 }),
      baseItem({ id: "TASK-02", title: "Signup", status: "todo", parentId: "INIT-01", order: 2 }),
    ];
    const out = renderProgressSummary("test", tasks);
    assert.ok(out.includes("INIT-01"));
    assert.ok(out.includes("[1/2]"));
    assert.ok(out.includes("Login"));
    assert.ok(out.includes("Signup"));
  });
});

describe("Task workflow service attention", () => {
  const session = testSession("svc-attention");
  after(() => cleanupSession(session));

  it("signals stale working assignee when they have no active work", async () => {
    const devId = newAgentId();
    const archId = newAgentId();
    const now = new Date().toISOString();
    await registerAgent(session, {
      id: devId, name: "Dev", session, role: "developer",
      cwd: "/tmp", pid: 1, status: "online", availability: "working",
      registeredAt: now, lastHeartbeat: now,
    });
    await registerAgent(session, {
      id: archId, name: "Arch", session, role: "architect",
      cwd: "/tmp", pid: 2, status: "online", availability: "idle",
      registeredAt: now, lastHeartbeat: now,
    });
    const item = await addTask(session, {
      title: "Wake stale worker", status: "todo",
      createdBy: "Test", createdAt: now, updatedAt: now,
    });

    const result = await serviceAssignTasks(session, [item.id], devId, "Dev", archId, "Arch");

    assert.equal(result.shouldSignal, true);
    const dev = await findById(session, devId);
    assert.equal(dev!.attentionPending, true);
  });
});

describe("Task workflow service", () => {
  const session = testSession("svc");
  const devId = newAgentId();
  const archId = newAgentId();
  after(() => cleanupSession(session));

  it("setup: register agents and create tasks", async () => {
    await registerAgent(session, {
      id: devId, name: "Dev", session, role: "developer",
      cwd: "/tmp", pid: 1, status: "online", availability: "idle",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    await registerAgent(session, {
      id: archId, name: "Arch", session, role: "architect",
      cwd: "/tmp", pid: 2, status: "online", availability: "idle",
      registeredAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const base = { createdBy: "Test", createdAt: now, updatedAt: now };
    await addTask(session, { title: "First", status: "todo", files: ["a.ts"], ...base });
    await addTask(session, { title: "Second", status: "todo", ...base });
    await addTask(session, { title: "Third", status: "todo", dependsOn: ["TASK-01"], ...base });
  });

  it("serviceAssignTasks assigns batch and detects idle target", async () => {
    const result = await serviceAssignTasks(session, ["TASK-01", "TASK-02"], devId, "Dev", archId, "Arch");
    assert.equal(result.assigned.length, 2);
    assert.equal(result.assigned[0]!.status, "assigned");
    assert.equal(result.shouldSignal, true);
  });

  it("servicePickTask prefers assigned-to-self", async () => {
    const result = await servicePickTask(session, undefined, devId, "Dev");
    assert.equal(result.task.id, "TASK-01");
    assert.equal(result.task.status, "in-progress");
  });

  it("servicePickTask rejects task with unmet deps", async () => {
    await assert.rejects(
      () => servicePickTask(session, "TASK-03", devId, "Dev"),
      /unfinished dependencies/
    );
  });

  it("serviceReviewTask marks in-progress work ready for review", async () => {
    const result = await serviceReviewTask(session, "TASK-01", devId, "Dev", "Ready!");
    assert.equal(result.task.status, "review");
    assert.equal(result.task.summary, "Ready!");
  });

  it("serviceCompleteTask lets a reviewer complete review-ready work", async () => {
    const result = await serviceCompleteTask(session, "TASK-01", archId, "Arch", "Integrated!");
    assert.equal(result.task.status, "done");
    assert.equal(result.task.summary, "Integrated!");
  });

  it("servicePickTask allows dep-met task after completion", async () => {
    const result = await servicePickTask(session, "TASK-03", devId, "Dev");
    assert.equal(result.task.id, "TASK-03");
  });

  it("serviceDropTask returns to queue", async () => {
    const result = await serviceDropTask(session, "TASK-03", devId, "Dev");
    assert.equal(result.task.status, "todo");
    assert.equal(result.task.assignee, undefined);
  });

  it("serviceBlockTask enforces ownership", async () => {
    await servicePickTask(session, "TASK-02", devId, "Dev");
    await assert.rejects(
      () => serviceBlockTask(session, "TASK-02", archId, "Arch", "test"),
      /Only the assignee/
    );
    const result = await serviceBlockTask(session, "TASK-02", devId, "Dev", "Waiting on API");
    assert.equal(result.task.status, "blocked");
  });
});
describe("CLI read-only commands", () => {
  const session = testSession("cli");
  const cliPath = join(process.cwd(), "cli/index.ts");

  function runCli(...args: string[]): string {
    return execFileSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, AMUX_SESSIONS_DIR: TEST_ROOT },
      encoding: "utf8",
      stderr: "pipe",
    });
  }

  it("prints honest read-only help", () => {
    const out = runCli("--help");
    assert.ok(out.includes("phase 1: read-only"));
    assert.ok(out.includes("progress"));
    assert.ok(out.includes("task list"));
    assert.equal(out.includes("Manage tasks (add"), false);
  });

  it("renders progress, show, list, and task list using shared data", async () => {
    const now = new Date().toISOString();
    const item = await addTask(session, {
      title: "CLI visible task", status: "todo",
      createdBy: "Test", createdAt: now, updatedAt: now,
    });

    const progress = runCli("progress", "--session", session);
    assert.ok(progress.includes(`Project: ${session}`));
    assert.ok(progress.includes("CLI visible task"));

    const show = runCli("--session", session, "show", item.id);
    assert.ok(show.includes(`${item.id}: CLI visible task`));

    const list = runCli("list", "-s", session);
    assert.ok(list.includes("Backlog (1 item)"));
    assert.ok(list.includes("CLI visible task"));

    const taskList = runCli("task", "list", "--session=" + session);
    assert.ok(taskList.includes("CLI visible task"));
  });

  it("renders status", async () => {
    const agentId = newAgentId();
    const now = new Date().toISOString();
    await registerAgent(session, {
      id: agentId, name: "CliAgent", session, role: "developer",
      cwd: "/tmp", pid: 1, status: "online", availability: "idle",
      registeredAt: now, lastHeartbeat: now,
    });

    const out = runCli("status", "--session", session);
    assert.ok(out.includes("CliAgent"));
    assert.ok(out.includes("online"));
  });
});

describe("Message staleness metadata", () => {
  it("formatMessageAge handles various time ranges", () => {
    const now = Date.now();
    assert.equal(formatMessageAge(new Date(now - 5000).toISOString()), "5s ago");
    assert.equal(formatMessageAge(new Date(now - 120000).toISOString()), "2m ago");
    assert.equal(formatMessageAge(new Date(now - 7200000).toISOString()), "2h ago");
    assert.equal(formatMessageAge(new Date(now - 172800000).toISOString()), "2d ago");
    assert.equal(formatMessageAge(new Date(now + 1000).toISOString()), "just now");
  });

  it("InboxMessage category and taskId are optional", () => {
    const msg: InboxMessage = {
      id: "test", from: "a", fromName: "Alice", fromSession: "s",
      timestamp: new Date().toISOString(), message: "Hello",
    };
    assert.equal(msg.category, undefined);
    assert.equal(msg.taskId, undefined);

    const withMeta: InboxMessage = {
      ...msg, category: "fyi", taskId: "TASK-01",
    };
    assert.equal(withMeta.category, "fyi");
    assert.equal(withMeta.taskId, "TASK-01");
  });
});

describe("Role profiles and team templates", () => {
  const session = testSession("roles");
  after(() => cleanupSession(session));

  it("lists bundled role templates", () => {
    const templates = listRoleTemplates();
    assert.ok(templates.includes("lead-architect"));
    assert.ok(templates.includes("developer"));
    assert.ok(templates.includes("reviewer"));
  });

  it("lists bundled team templates", () => {
    const teams = listTeamTemplates();
    const coreTeam = teams.find((t) => t.name === "core-team");
    assert.ok(coreTeam);
    assert.equal(coreTeam!.roles.length, 3);
    assert.ok(coreTeam!.roles.some((r) => r.name === "lead-architect"));
  });

  it("reads bundled role template markdown", () => {
    const content = readRoleTemplate("lead-architect");
    assert.ok(content);
    assert.ok(content!.includes("Lead Architect"));
    assert.ok(content!.includes("## Mission"));
  });

  it("returns null for missing template", () => {
    assert.equal(readRoleTemplate("nonexistent-role"), null);
  });

  it("copyRoleProfile copies markdown to project artifacts", () => {
    const relPath = copyRoleProfile(session, "developer", "developer");
    assert.equal(relPath, "roles/developer.md");
    const fullPath = roleProfileFullPath(session, relPath!);
    assert.ok(existsSync(fullPath));
    const content = readF(fullPath, "utf8");
    assert.ok(content.includes("Developer"));
  });

  it("copyRoleProfile preserves customized file without force", () => {
    const relPath = roleProfileRelPath("developer");
    const fullPath = roleProfileFullPath(session, relPath);
    // Customize the file
    writeFileSync(fullPath, "# Custom Developer\n\nMy edits.", "utf8");
    // Copy again without force
    copyRoleProfile(session, "developer", "developer");
    const content = readF(fullPath, "utf8");
    assert.ok(content.includes("My edits"), "Customized file should be preserved");
  });

  it("copyRoleProfile overwrites with force", () => {
    copyRoleProfile(session, "developer", "developer", true);
    const fullPath = roleProfileFullPath(session, roleProfileRelPath("developer"));
    const content = readF(fullPath, "utf8");
    assert.ok(content.includes("## Mission"), "Force should restore bundled content");
  });

  it("applyTeamTemplate registers roles with profilePath (no agents)", async () => {
    const result = await applyTeamTemplate(session, "core-team");
    assert.ok(result);
    assert.equal(result!.applied.length, 3);
    assert.ok(result!.applied.includes("lead-architect"));

    // Roles registered with profilePath
    const role = await getRole(session, "lead-architect");
    assert.ok(role);
    assert.equal(role!.profilePath, "roles/lead-architect.md");
    assert.equal(role!.templateName, "lead-architect");

    // No agents created
    const registry = await readRegistry(session);
    assert.equal(Object.keys(registry).length, 0, "apply-template must not create agents");
  });

  it("resolveRoleInstructions reads profilePath as source of truth", async () => {
    const role = await getRole(session, "lead-architect");
    const resolved = resolveRoleInstructions(session, role!);
    assert.ok(resolved.includes("Lead Architect"));
    assert.ok(resolved.includes("orchestrate") || resolved.includes("coordinate"));
  });

  it("resolveRoleInstructions reflects edits to the profile file", async () => {
    const role = await getRole(session, "developer");
    const fullPath = roleProfileFullPath(session, role!.profilePath!);
    writeFileSync(fullPath, "# Edited\n\nNew instructions.", "utf8");
    const resolved = resolveRoleInstructions(session, role!);
    assert.ok(resolved.includes("New instructions"), "Profile file edits should win");
  });

  it("resolveRoleInstructions falls back to inline instructions", () => {
    const inlineRole = { name: "inline", instructions: "Inline instructions." };
    const resolved = resolveRoleInstructions(session, inlineRole);
    assert.equal(resolved, "Inline instructions.");
  });
});

describe("Prompt assembly", () => {
  it("composes sections in the deliberate order", () => {
    const out = assembleAgentPrompt({
      commonPrinciples: "COMMON",
      projectContext: "CONTEXT",
      roleProfile: "ROLE",
      identity: "IDENTITY",
      workState: "WORK",
      teamContext: "TEAM",
      interfaceGuidance: "INTERFACE",
    });
    const order = ["COMMON", "CONTEXT", "ROLE", "IDENTITY", "WORK", "TEAM", "INTERFACE"];
    // Each section appears, and in the right relative order
    let lastIdx = -1;
    for (const section of order) {
      const idx = out.indexOf(section);
      assert.ok(idx > lastIdx, `${section} should follow the previous section`);
      lastIdx = idx;
    }
  });

  it("skips empty and whitespace-only sections", () => {
    const out = assembleAgentPrompt({
      commonPrinciples: "COMMON",
      projectContext: "",
      roleProfile: "   ",
      identity: "IDENTITY",
    });
    assert.ok(out.includes("COMMON"));
    assert.ok(out.includes("IDENTITY"));
    // No empty-section artifacts (no triple newlines from skipped sections)
    assert.ok(!out.includes("\n\n\n"));
    assert.equal(out, "COMMON\n\nIDENTITY");
  });

  it("returns empty string when all sections are empty", () => {
    assert.equal(assembleAgentPrompt({}), "");
    assert.equal(assembleAgentPrompt({ roleProfile: "", workState: "  " }), "");
  });

  it("joins sections with blank-line separators", () => {
    const out = assembleAgentPrompt({ commonPrinciples: "A", roleProfile: "B" });
    assert.equal(out, "A\n\nB");
  });

  it("COMMON_PRINCIPLES contains the collaboration contract", () => {
    assert.ok(COMMON_PRINCIPLES.includes("State is the source of truth"));
    assert.ok(COMMON_PRINCIPLES.includes("amux_task comment"));
    assert.ok(COMMON_PRINCIPLES.includes("executable leaf"));
    assert.ok(COMMON_PRINCIPLES.includes("Review before done"));
  });
});

describe("Prompt preview / debug surface", () => {
  it("PROMPT_SECTION_ORDER lists all eight sections in the deliberate order", () => {
    assert.deepEqual([...PROMPT_SECTION_ORDER], [
      "commonPrinciples",
      "waysOfWorking",
      "projectContext",
      "roleProfile",
      "identity",
      "workState",
      "teamContext",
      "interfaceGuidance",
    ]);
  });

  it("gatheredSectionNames lists present sections, skippedSectionNames lists absent ones", () => {
    const sections = {
      commonPrinciples: "COMMON",
      identity: "IDENT",
      roleProfile: "ROLE",
    };
    assert.deepEqual(gatheredSectionNames(sections), ["Common principles", "Role profile", "Identity & workspace"]);
    const skipped = skippedSectionNames(sections);
    assert.ok(skipped.includes("Ways of Working"));
    assert.ok(skipped.includes("Work state"));
    assert.equal(skipped.length, PROMPT_SECTION_ORDER.length - 3);
  });

  it("treats whitespace-only sections as skipped", () => {
    const skipped = skippedSectionNames({ workState: "   \n  ", projectContext: "\t" });
    assert.ok(skipped.includes("Work state"));
    assert.ok(skipped.includes("Project context"));
    assert.deepEqual(gatheredSectionNames({ workState: "   " }), []);
  });

  it("formatPromptSummary is non-polluting by default", () => {
    const out = formatPromptSummary({ commonPrinciples: "COMMON", identity: "IDENT" });
    assert.ok(out.includes("APPENDS a coordination block"));
    assert.ok(out.includes("base system prompt is NOT shown"));
    assert.equal(out.includes("Pi's base system prompt"), false);
    assert.ok(/Sections gathered \(2\/8\)/.test(out));
    assert.ok(out.includes("/amux prompt all"));
    assert.equal(out.includes("---- composed block"), false);
    assert.equal(out.includes("COMMON"), false);
    assert.equal(out.includes("IDENT"), false);
  });

  it("formatPromptSectionPreview shows one focused section", () => {
    const out = formatPromptSectionPreview({ commonPrinciples: "COMMON", identity: "IDENT" }, "identity");
    assert.ok(out.includes("Section: Identity & workspace (identity)"));
    assert.ok(out.includes("IDENT"));
    assert.equal(out.includes("COMMON"), false);
  });

  it("formatPromptPreview states the base prompt is NOT shown and includes full block only when explicit", () => {
    const out = formatPromptPreview({ commonPrinciples: "COMMON", identity: "IDENT" });
    assert.ok(out.includes("APPENDS a coordination block"));
    assert.ok(out.includes("base system prompt is NOT shown"));
    assert.equal(out.includes("Pi's base system prompt"), false);
    assert.ok(/Sections gathered \(2\/8\)/.test(out));
    // The composed block is included verbatim
    assert.ok(out.includes("---- composed block (appended to base prompt) ----"));
    assert.ok(out.includes("COMMON"));
    assert.ok(out.includes("IDENT"));
    // Skipped sections are surfaced for debugging
    assert.ok(out.includes("Sections empty/skipped"));
  });

  it("formatPromptPreview reports none gathered and explains nothing is appended when all empty", () => {
    const out = formatPromptPreview({});
    assert.match(out, /Sections gathered \(0\/8\): \(none\)/);
    assert.ok(out.includes("nothing is appended to the base prompt"));
  });

  it("formatPromptPreview composes the block in the same order as assembleAgentPrompt", () => {
    const sections = { commonPrinciples: "A", roleProfile: "B", identity: "C" };
    const preview = formatPromptPreview(sections);
    const marker = preview.indexOf("---- composed block");
    const block = preview.slice(marker);
    assert.ok(block.indexOf("A") < block.indexOf("B"));
    assert.ok(block.indexOf("B") < block.indexOf("C"));
  });
});

describe("Public core barrel", () => {
  it("does not re-export duplicate names from wildcard exports", () => {
    const indexPath = join(process.cwd(), "core", "index.ts");
    const index = readF(indexPath, "utf8");
    const modules = [...index.matchAll(/^export \* from "\.\/(.+)";$/gm)].map((m) => m[1]!);
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const mod of modules) {
      const path = join(process.cwd(), "core", `${mod}.ts`);
      const source = readF(path, "utf8");
      const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+([A-Za-z0-9_]+)/gm)]
        .map((m) => m[1]!);
      for (const name of names) {
        const previous = seen.get(name);
        if (previous) duplicates.push(`${name} (${previous}, ${mod})`);
        else seen.set(name, mod);
      }
    }
    assert.deepEqual(duplicates, []);
  });
});

describe("Ways of Working (WOW.md)", () => {
  const session = testSession("wow");
  after(() => cleanupSession(session));

  it("returns null when WOW.md does not exist", () => {
    assert.equal(readWaysOfWorking(session), null);
  });

  it("writes and reads WoW content", () => {
    writeWaysOfWorking(session, "## Communication\nPrefer task comments over DMs.");
    const content = readWaysOfWorking(session);
    assert.ok(content);
    assert.ok(content!.includes("Prefer task comments"));
    assert.ok(content!.includes("## Communication"));
  });

  it("appends to existing WoW", () => {
    appendWaysOfWorking(session, "## Review\nRequire review before done.");
    const content = readWaysOfWorking(session);
    assert.ok(content!.includes("Prefer task comments"));
    assert.ok(content!.includes("Require review"));
  });

  it("clear empties WoW (read returns null)", () => {
    clearWaysOfWorking(session);
    assert.equal(readWaysOfWorking(session), null, "empty content trimmed to null");
  });

  it("wowPath is under artifacts/project", () => {
    const path = wowPath(session);
    assert.ok(path.includes("artifacts/project"));
    assert.ok(path.endsWith("WOW.md"));
  });

  it("assembler injects WoW after common principles", () => {
    const out = assembleAgentPrompt({
      commonPrinciples: "COMMON",
      waysOfWorking: "WOW",
      projectContext: "CTX",
    });
    const commonIdx = out.indexOf("COMMON");
    const wowIdx = out.indexOf("WOW");
    const ctxIdx = out.indexOf("CTX");
    assert.ok(commonIdx < wowIdx, "WoW must follow common principles");
    assert.ok(wowIdx < ctxIdx, "project context must follow WoW");
  });

  it("empty WoW section is skipped", () => {
    const out = assembleAgentPrompt({
      commonPrinciples: "COMMON",
      waysOfWorking: "",
      projectContext: "CTX",
    });
    assert.ok(!out.includes("Ways of Working"));
    assert.ok(out.includes("COMMON"));
    assert.ok(out.includes("CTX"));
  });
});
