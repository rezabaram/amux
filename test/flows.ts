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
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  readRoles,
  addRole,
  removeRole,
  getRole,
  readSessionConfig,
  writeSessionConfig,
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
} from "../core/backlog.ts";

import {
  reserve,
  release,
  checkConflict,
  clearStaleReservations,
  getReservations,
} from "../core/reservations.ts";

import {
  appendEntry,
  readEntries,
  getRecentEntries,
} from "../core/journal.ts";

// -- Helpers --

const SESSIONS_DIR = join(homedir(), ".amux", "sessions");

function testSession(name: string): string {
  return `_test_${name}_${process.pid}`;
}

function cleanupSession(session: string): void {
  const dir = join(SESSIONS_DIR, session);
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

  it("architect creates task and sends notification", async () => {
    await goOnline(session, architectId, process.pid);

    await addTask(session, {
      title: "Add validation", status: "todo", files: ["src/auth.ts"],
      createdBy: "Alice", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    ensureInbox(session, developerId);
    sendToInbox(session, developerId, {
      id: newMessageId(), from: architectId, fromName: "Alice",
      fromRole: "architect", fromSession: session,
      timestamp: new Date().toISOString(), message: "TASK-01 assigned to you",
    });

    assert.equal(getRecoverableMessages(session, developerId).length, 1);
  });

  it("developer joins, picks up message, picks task, reserves files", async () => {
    await goOnline(session, developerId, process.pid);

    // Process message
    const msgs = getRecoverableMessages(session, developerId);
    appendToHistory(session, msgs[0]!.msg);
    markAsDelivered(session, developerId, msgs[0]!.filename);
    confirmDelivered(session, developerId);

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
