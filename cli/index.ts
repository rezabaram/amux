#!/usr/bin/env -S node --experimental-strip-types
/**
 * amux CLI — Agent Multiplexer command-line interface
 *
 * Phase 1: read-only commands using shared core services/renderers.
 * For full interactive and mutation workflows, use the Pi extension.
 */

import { readBacklog } from "../core/backlog.ts";
import { readRegistry, isEffectivelyOnline } from "../core/registry.ts";
import { renderProgressSummary, renderTaskDetails, renderTaskListRow } from "../core/renderers.ts";
import { serviceGetTaskShowData } from "../core/task-service.ts";
import { listSessions } from "../core/storage.ts";

// ─── Arg Parsing ─────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  session?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let session: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--session" || arg === "-s") {
      session = argv[++i];
      if (!session) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
    } else if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
    } else {
      positional.push(arg);
    }
  }

  return { positional, session };
}

const { positional, session } = parseArgs(process.argv.slice(2));
const cmd = positional[0] ?? "help";

async function requireSession(): Promise<string> {
  if (session) return session;
  const sessions = await listSessions();
  if (sessions.length === 1) return sessions[0]!;
  if (sessions.length === 0) {
    console.error("No sessions found. Create a project with the Pi extension first.");
    process.exit(1);
  }
  console.error(
    `Multiple sessions found. Specify one with --session:\n  ${sessions.join("\n  ")}`
  );
  process.exit(1);
}

function printHelp(): void {
  console.log(`amux — Agent Multiplexer CLI (phase 1: read-only)

Usage: amux <command> [--session <name>]

Commands:
  progress              Project progress overview
  show <ITEM-ID>        Item details with comments and spec preview
  list                  Backlog listing
  task list             Backlog listing (explicit task namespace)
  status                Online agents and availability
  help                  Show this help

Options:
  --session, -s <name>  Session/project name (auto-detected if only one)

For full interactive workflows (create, assign, pick, manage):
  pi install git:github.com/amutix/amux

Documentation: https://github.com/amutix/amux`);
}

// ─── Commands ────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h": {
      printHelp();
      break;
    }

    case "progress": {
      const s = await requireSession();
      const tasks = await readBacklog(s);
      console.log(renderProgressSummary(s, tasks));
      break;
    }

    case "show": {
      const s = await requireSession();
      const itemId = positional[1];
      if (!itemId) {
        console.error("Usage: amux show <ITEM-ID> [--session <name>]");
        process.exit(1);
      }
      const data = await serviceGetTaskShowData(s, itemId);
      console.log(
        renderTaskDetails(data.task, data.allTasks, {
          comments: data.comments,
          specPreview: data.specPreview,
        })
      );
      break;
    }

    case "list":
    case "task": {
      if (cmd === "task" && positional[1] !== "list") {
        console.error('Usage: amux task list [--session <name>]');
        process.exit(1);
      }
      const s = await requireSession();
      const tasks = await readBacklog(s);
      if (tasks.length === 0) {
        console.log("No backlog items.");
        break;
      }
      console.log(`Backlog (${tasks.length} item${tasks.length !== 1 ? "s" : ""}):\n`);
      for (const [i, task] of tasks.entries()) {
        console.log(renderTaskListRow(task, tasks, i + 1));
      }
      break;
    }

    case "status": {
      const s = await requireSession();
      const registry = await readRegistry(s);
      const agents = Object.values(registry);
      if (agents.length === 0) {
        console.log(`Session: ${s}\nNo agents registered.`);
        break;
      }
      console.log(`Session: ${s}\n`);
      for (const a of agents) {
        const online = isEffectivelyOnline(a) ? "online" : "offline";
        const avail = a.availability ? `, ${a.availability}` : "";
        const role = a.roleName || a.role;
        console.log(`  ${a.name} (${role}) [${online}${avail}]`);
      }
      break;
    }

    default:
      console.error(`amux: unknown command "${cmd}". Run "amux --help" for usage.`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(err.message || err);
  process.exit(1);
});
