#!/usr/bin/env node
/**
 * amutix CLI release entrypoint.
 *
 * This file is plain JavaScript because current Node type stripping does not
 * load TypeScript files from node_modules. The source-oriented TypeScript CLI
 * remains in cli/index.ts; this entrypoint mirrors the read-only commands.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function sessionsDir() {
  if (process.env.AMUTIX_SESSIONS_DIR) return process.env.AMUTIX_SESSIONS_DIR;
  if (process.env.AMUX_SESSIONS_DIR) return process.env.AMUX_SESSIONS_DIR; // legacy alias
  if (process.env.AMUTIX_HOME) return join(process.env.AMUTIX_HOME, "sessions");
  if (process.env.AMUX_HOME) return join(process.env.AMUX_HOME, "sessions"); // legacy alias
  const canonical = join(homedir(), ".amutix", "sessions");
  if (existsSync(canonical)) return canonical;
  return join(homedir(), ".amux", "sessions"); // legacy read-fallback (pre-2.0)
}

function sessionFile(session, ...parts) {
  return join(sessionsDir(), session, ...parts);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function readJsonl(path) {
  const raw = readText(path);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function listSessions() {
  try {
    return readdirSync(sessionsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const positional = [];
  let session;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session" || arg === "-s") session = argv[++i];
    else if (arg.startsWith("--session=")) session = arg.slice("--session=".length);
    else positional.push(arg);
  }
  return { positional, session };
}

const { positional, session } = parseArgs(process.argv.slice(2));
const cmd = positional[0] ?? "help";

function requireSession() {
  if (session) return session;
  const sessions = listSessions();
  if (sessions.length === 1) return sessions[0];
  if (sessions.length === 0) die("No sessions found. Create a project with the Pi extension first.");
  die(`Multiple sessions found. Specify one with --session:\n  ${sessions.join("\n  ")}`);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`amutix — Coordination CLI for AI agent teams (read-only)\n\nUsage: amutix <command> [--session <name>]\n\nCommands:\n  work                  Project progress overview\n  work show <ITEM-ID>   Item details with comments and spec preview\n  team                  Agents and availability\n  project               Project vision/WoW/role overview\n  list                  Backlog listing\n  task list             Backlog listing (explicit task namespace)\n  progress              Alias for work\n  show <ITEM-ID>        Alias for work show\n  status                Alias for team\n  help                  Show this help\n\nOptions:\n  --session, -s <name>  Session/project name (auto-detected if only one)\n\nFor full interactive workflows: use the Pi extension.\nDocumentation: https://github.com/amutix/amutix`);
}

function readBacklog(session) {
  return readJson(sessionFile(session, "backlog.json"), []);
}

function itemTypeLabel(task) {
  return task.itemType && task.itemType !== "task" ? ` (${task.itemType})` : "";
}

function marker(status) {
  if (status === "done") return "✓";
  if (status === "blocked") return "!";
  if (status === "review") return "◆";
  if (status === "in-progress") return "●";
  if (status === "assigned") return "○";
  return "•";
}

function childrenOf(tasks, parentId) {
  return tasks.filter((t) => t.parentId === parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function renderTaskLine(task, tasks, indent = "") {
  const kids = childrenOf(tasks, task.id);
  const progress = kids.length ? ` [${kids.filter((k) => k.status === "done").length}/${kids.length}]` : "";
  const assignee = task.assignee ? ` @${task.assignee}` : "";
  return `${indent}${marker(task.status)} ${task.id}${itemTypeLabel(task)}  ${task.title}${progress}${assignee}`;
}

function renderProgress(session, tasks) {
  if (!tasks.length) return `Project: ${session}\nNo backlog items.`;
  const total = tasks.length;
  const counts = Object.fromEntries(["todo", "assigned", "in-progress", "review", "blocked", "done"].map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const countsLine = ["in-progress", "review", "blocked", "assigned", "todo", "done"]
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(" · ");
  const roots = tasks.filter((t) => !t.parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const lines = [`Project: ${session}`, "────────────────────────────────────────", `${countsLine}  (${total} total)`, ""];
  const walk = (task, indent = "") => {
    lines.push(renderTaskLine(task, tasks, indent));
    for (const child of childrenOf(tasks, task.id)) walk(child, `${indent}    `);
  };
  roots.forEach((t) => walk(t));
  return lines.join("\n");
}

function renderList(tasks) {
  if (!tasks.length) return "No backlog items.";
  return `Backlog (${tasks.length} item${tasks.length === 1 ? "" : "s"}):\n\n` + tasks.map((task, i) => `  #${i + 1}  ${renderTaskLine(task, tasks)}`).join("\n");
}

function truncate(text, max = 500) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function renderShow(session, id) {
  const tasks = readBacklog(session);
  const task = tasks.find((t) => t.id === id);
  if (!task) die(`Backlog item not found: ${id}`);
  const comments = readJsonl(sessionFile(session, "task-comments", `${id}.jsonl`));
  const specPath = sessionFile(session, "artifacts", "project", "tasks", `${id}.md`);
  const spec = existsSync(specPath) ? readText(specPath) : "";
  const lines = [
    `${task.id}${itemTypeLabel(task)}  ${task.title}`,
    `Status: ${task.status}`,
  ];
  if (task.assignee) lines.push(`Assignee: ${task.assignee}`);
  if (task.parentId) lines.push(`Parent: ${task.parentId}`);
  if (task.dependsOn?.length) lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
  if (task.files?.length) lines.push(`Files: ${task.files.join(", ")}`);
  if (task.summary) lines.push(`${task.status === "review" ? "Review handoff" : "Summary"}: ${truncate(task.summary)}`);
  if (spec) lines.push("", `Spec: ${specPath}`, truncate(spec, 1200));
  if (comments.length) {
    const substantive = comments.filter((c) => c.type !== "activity");
    const activity = comments.length - substantive.length;
    lines.push("", `Discussion projection: ${substantive.length} comments, ${activity} activity events.`);
    const latest = substantive.at(-1);
    if (latest) lines.push(`Latest from ${latest.agent || latest.author || "unknown"}: ${truncate(latest.text || latest.content || "")}`);
  }
  return lines.join("\n");
}

function isOnline(agent) {
  if (agent.status !== "online") return false;
  const ttl = 90_000;
  return Date.now() - new Date(agent.lastHeartbeat || 0).getTime() < ttl;
}

function renderTeam(session) {
  const registry = readJson(sessionFile(session, "agents.json"), {});
  const agents = Object.values(registry);
  if (!agents.length) return `Session: ${session}\nNo agents registered.`;
  return `Session: ${session}\n\n` + agents.map((a) => {
    const role = a.roleName || a.role || "agent";
    const avail = a.availability ? `, ${a.availability}` : "";
    return `  ${a.name} (${role}) [${isOnline(a) ? "online" : "offline"}${avail}]`;
  }).join("\n");
}

function renderProject(session) {
  const context = readText(sessionFile(session, "artifacts", "project", "CONTEXT.md")) || "(none)";
  const wow = readText(sessionFile(session, "artifacts", "project", "WOW.md")) || "(none)";
  const roles = Object.keys(readJson(sessionFile(session, "roles.json"), {}));
  return `Project: ${session}\n\nVision/context:\n${context}\n\nWays of Working:\n${wow}\n\nRoles: ${roles.length ? roles.join(", ") : "(none)"}`;
}

switch (cmd) {
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  case "progress":
  case "work": {
    const s = requireSession();
    const sub = cmd === "work" ? positional[1] : undefined;
    if (sub === "show") {
      const id = positional[2];
      if (!id) die("Usage: amutix work show <ITEM-ID> [--session <name>]");
      console.log(renderShow(s, id));
    } else if (!sub || sub === "summary" || sub === "progress") {
      console.log(renderProgress(s, readBacklog(s)));
    } else {
      die("Usage: amutix work [show <ITEM-ID>] [--session <name>]");
    }
    break;
  }
  case "show": {
    const s = requireSession();
    const id = positional[1];
    if (!id) die("Usage: amutix show <ITEM-ID> [--session <name>]");
    console.log(renderShow(s, id));
    break;
  }
  case "list":
  case "task": {
    if (cmd === "task" && positional[1] !== "list") die("Usage: amutix task list [--session <name>]");
    console.log(renderList(readBacklog(requireSession())));
    break;
  }
  case "status":
  case "team":
    console.log(renderTeam(requireSession()));
    break;
  case "project":
    console.log(renderProject(requireSession()));
    break;
  default:
    die(`amutix: unknown command "${cmd}". Run "amutix --help" for usage.`);
}
