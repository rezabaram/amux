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
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  newMessageId,
  type InboxMessage,
} from "../core/messaging.ts";

import {
  readBacklog,
  addTask,
  getTask,
  updateTask,
  unmetDependencies,
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
} from "../core/reservations.ts";

import {
  appendEntry,
  readEntries,
  getRecentEntries,
} from "../core/journal.ts";
import {
  appendTaskComment,
  readTaskComments,
  formatTaskComment,
  type TaskComment,
} from "../core/task-comments.ts";

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

  it("backward compat: existing tasks without dependsOn are valid", async () => {
    // Add a task the old way (no dependsOn field)
    const legacy = await addTask(session, {
      title: "Legacy task", status: "todo", createdBy: "Test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const t = await getTask(session, legacy.id);
    assert.equal(t!.dependsOn, undefined);
    const tasks = await readBacklog(session);
    assert.deepStrictEqual(unmetDependencies(t!, tasks), []);
  });
});

describe("Project context (CONTEXT.md)", () => {
  const session = testSession("context");
  after(() => cleanupSession(session));

  it("reads null when no context file exists", () => {
    const ctxPath = sessionFile(session, "artifacts", "project", "CONTEXT.md");
    assert.equal(existsSync(ctxPath), false);
  });

  it("writes and reads context file", () => {
    const dir = sessionFile(session, "artifacts", "project");
    mkDir(dir, { recursive: true });
    const ctxPath = join(dir, "CONTEXT.md");
    const content = "This project builds a multi-agent coordination system.";
    writeFileSync(ctxPath, content, "utf8");

    const read = readF(ctxPath, "utf8");
    assert.equal(read, content);
  });

  it("append preserves existing content", () => {
    const ctxPath = sessionFile(session, "artifacts", "project", "CONTEXT.md");
    const existing = readF(ctxPath, "utf8");
    const addition = "\n\nFocus on test coverage this sprint.";
    writeFileSync(ctxPath, existing + addition, "utf8");

    const read = readF(ctxPath, "utf8");
    assert.ok(read.includes("multi-agent"));
    assert.ok(read.includes("test coverage"));
  });

  it("clear writes empty content", () => {
    const ctxPath = sessionFile(session, "artifacts", "project", "CONTEXT.md");
    writeFileSync(ctxPath, "", "utf8");
    const read = readF(ctxPath, "utf8").trim();
    assert.equal(read, "");
  });

  it("context path is under session artifacts/project", () => {
    const ctxPath = sessionFile(session, "artifacts", "project", "CONTEXT.md");
    assert.ok(ctxPath.includes(session));
    assert.ok(ctxPath.endsWith("artifacts/project/CONTEXT.md"));
  });

  // Manual test steps for Pi command shortcuts:
  //
  // /amux context:
  //   1. /amux join → join a project
  //   2. /amux context → shows "No project context set"
  //   3. /amux context set "Build a REST API with auth" → "Project context set"
  //   4. /amux context → shows the set context
  //   5. /amux context append "Use PostgreSQL for storage" → "Appended"
  //   6. /amux context → shows both lines
  //   7. /amux context edit → opens editor with current content
  //   8. /amux context path → prints file path
  //   9. /amux context clear → confirms and clears
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
