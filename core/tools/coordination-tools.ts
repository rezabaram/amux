/**
 * Neutral coordination tools.
 *
 * Migrates `amux_role`, `amux_reserve`, and `amux_journal` out of the Pi
 * adapter. These tools coordinate roles, file reservations, and shared
 * journal entries through framework-independent core services.
 */

import {
  type AgentInfo,
  addRole,
  getOnlineAgents,
  getRole,
  readRegistry,
  readRoles,
  removeRole,
} from "../registry.ts";
import {
  applyTeamTemplate,
  isBuiltinRole,
  listRoleTemplates,
  listTeamTemplates,
  resolveRoleInstructions,
  roleProfileFullPath,
} from "../roles.ts";
import {
  reserve,
  release,
  getReservations,
  formatReservationAge,
  reservationTaskId,
} from "../reservations.ts";
import { readBacklog } from "../backlog.ts";
import { renderAgentWorkState } from "../renderers.ts";
import {
  appendEntry as addJournalEntry,
  readEntries as readJournalEntries,
  formatEntry as formatJournalEntry,
  type JournalEntry,
} from "../journal.ts";
import {
  type AmuxToolContext,
  type AmuxToolDefinition,
  type AmuxToolResult,
  enumProp,
  objectSchema,
  optionalStringProp,
  stringProp,
} from "./types.ts";

// ─── amux_role ───────────────────────────────────────────────

const ROLE_ACTIONS = ["add", "list", "remove", "templates", "apply-template", "show", "path"] as const;

type RoleAction = typeof ROLE_ACTIONS[number];

interface RoleParams {
  action: RoleAction;
  name?: string;
  instructions?: string;
  template?: string;
}

/** Get all agents (any status) that reference a given role. */
async function getRoleUsage(session: string, roleName: string): Promise<AgentInfo[]> {
  const registry = await readRegistry(session);
  return Object.values(registry).filter((a) => a.roleName === roleName);
}

export const roleTool: AmuxToolDefinition<RoleParams> = {
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
  inputSchema: objectSchema(
    {
      action: enumProp(ROLE_ACTIONS, "Action to perform"),
      name: optionalStringProp('Role name (required for "add", "remove", "show", "path")'),
      instructions: optionalStringProp('Instructions for the role  -- what the agent should do, focus on, and how to behave (required for "add")'),
      template: optionalStringProp('Team template name (required for "apply-template", e.g. "core-team")'),
    },
    ["action"],
  ),

  async execute(ctx, params): Promise<AmuxToolResult> {
    switch (params.action) {
      case "add": {
        if (!params.name) throw new Error("Role name is required for add.");
        if (!params.instructions) throw new Error("Instructions are required for add.");
        await addRole(ctx.session, { name: params.name, instructions: params.instructions });
        return {
          text: `Role "${params.name}" added. Agents can join with: /amux join`,
          details: { role: { name: params.name, instructions: params.instructions } },
        };
      }
      case "list": {
        const roles = await readRoles(ctx.session);
        const entries = Object.values(roles);
        if (entries.length === 0) {
          return { text: "No roles defined. Use amux_role with action=add to create one.", details: { roles: [] } };
        }
        const registry = await readRegistry(ctx.session);
        const allAgents = Object.values(registry);
        const lines = entries.map((r) => {
          const usedBy = allAgents.filter((a) => a.roleName === r.name).map((a) => a.name);
          const builtinTag = isBuiltinRole(r.name) ? "built-in" : "custom";
          const usageTag = usedBy.length > 0 ? `used by: ${usedBy.join(", ")}` : "unused";
          const truncInstr = r.instructions.slice(0, 100) + (r.instructions.length > 100 ? "…" : "");
          return `- ${r.name} [${builtinTag}, ${usageTag}]: ${truncInstr}`;
        });
        return { text: lines.join("\n"), details: { roles: entries } };
      }
      case "remove": {
        if (!params.name) throw new Error("Role name is required for remove.");
        if (isBuiltinRole(params.name)) {
          throw new Error(
            `Role "${params.name}" is a built-in role and cannot be deleted. ` +
            `Use action "add" to customize its instructions instead.`,
          );
        }
        const usedBy = await getRoleUsage(ctx.session, params.name);
        if (usedBy.length > 0) {
          const names = usedBy.map((a) => a.name).join(", ");
          throw new Error(`Role "${params.name}" is used by ${names}. Reassign them first.`);
        }
        const removed = await removeRole(ctx.session, params.name);
        if (!removed) throw new Error(`Role "${params.name}" not found.`);
        return { text: `Role "${params.name}" removed.`, details: {} };
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
        return { text, details: { roleTemplates, teamTemplates } };
      }
      case "apply-template": {
        if (!params.template) throw new Error("Template name is required for apply-template.");
        const result = await applyTeamTemplate(ctx.session, params.template);
        if (!result) {
          const available = listTeamTemplates().map((t) => t.name).join(", ");
          throw new Error(`Team template "${params.template}" not found. Available: ${available || "none"}`);
        }
        const agentHints = result.template.roles
          .filter((r) => r.agentName)
          .map((r) => `  ${r.name} → suggested agent "${r.agentName}" (workspace: ${r.workspace || "none"})`)
          .join("\n");
        let text = `Applied team template "${result.template.name}".\nRoles registered: ${result.applied.join(", ")}.`;
        if (agentHints) text += `\n\nSuggested agents (create separately via /amux new agent):\n${agentHints}`;
        return { text, details: result };
      }
      case "show": {
        if (!params.name) throw new Error("Role name is required for show.");
        const role = await getRole(ctx.session, params.name);
        if (!role) throw new Error(`Role "${params.name}" not found.`);
        const resolved = resolveRoleInstructions(ctx.session, role);
        let text = `# ${role.name}`;
        if (role.profilePath) text += `\nProfile: ${role.profilePath}`;
        if (role.templateName) text += `\nTemplate: ${role.templateName}`;
        text += `\n\n${resolved}`;
        return { text, details: { role } };
      }
      case "path": {
        if (!params.name) throw new Error("Role name is required for path.");
        const role = await getRole(ctx.session, params.name);
        if (!role) throw new Error(`Role "${params.name}" not found.`);
        if (!role.profilePath) {
          return { text: `Role "${params.name}" uses inline instructions and has no profile file.`, details: { role } };
        }
        const fullPath = roleProfileFullPath(ctx.session, role.profilePath);
        return { text: fullPath, details: { path: fullPath, profilePath: role.profilePath } };
      }
      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  },
};

// ─── amux_reserve ────────────────────────────────────────────

const RESERVE_ACTIONS = ["claim", "release", "list"] as const;
type ReserveAction = typeof RESERVE_ACTIONS[number];

interface ReserveParams {
  action: ReserveAction;
  paths?: string[];
  reason?: string;
}

export const reserveTool: AmuxToolDefinition<ReserveParams> = {
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
  inputSchema: objectSchema(
    {
      action: enumProp(RESERVE_ACTIONS, "Action to perform"),
      paths: { type: "array", items: stringProp("Paths to claim or release (trailing slash = directory prefix)"), description: "Paths to claim or release (trailing slash = directory prefix)" },
      reason: optionalStringProp("Why you're claiming these paths (shown to other agents)"),
    },
    ["action"],
  ),

  async execute(ctx, params): Promise<AmuxToolResult> {
    switch (params.action) {
      case "claim": {
        if (!params.paths?.length) throw new Error("Paths are required for claim.");
        const online = await getOnlineAgents(ctx.session).catch(() => [] as AgentInfo[]);
        const onlineIds = online.map((a) => a.id);
        const reserved = await reserve(ctx.session, params.paths, ctx.agentId, ctx.agentName, params.reason, onlineIds);
        const reasonNote = params.reason ? ` (${params.reason})` : "";
        return {
          text: `Reserved ${reserved.length} path(s)${reasonNote}:\n${reserved.map((p) => `  ✓ ${p}`).join("\n")}`,
          details: { reserved, reason: params.reason },
        };
      }
      case "release": {
        if (!params.paths?.length) throw new Error("Paths are required for release.");
        const released = await release(ctx.session, params.paths, ctx.agentId);
        if (released.length === 0) return { text: "No matching reservations found to release.", details: { released: [] } };
        return {
          text: `Released ${released.length} reservation(s):\n${released.map((p) => `  ✓ ${p}`).join("\n")}`,
          details: { released },
        };
      }
      case "list": {
        const reservations = await getReservations(ctx.session);
        const entries = Object.entries(reservations);
        if (entries.length === 0) return { text: "No active reservations.", details: { reservations: {} } };

        const online = await getOnlineAgents(ctx.session).catch(() => [] as AgentInfo[]);
        const onlineIds = new Set(online.map((a) => a.id));
        const backlog = await readBacklog(ctx.session);
        const lines = entries.map(([path, res]) => {
          const duration = formatReservationAge(res.since);
          const reasonStr = res.reason ? `  -- ${res.reason}` : "";
          const taskId = reservationTaskId(res);
          const taskStr = taskId ? ` [${taskId}]` : "";
          const stale = !onlineIds.has(res.agentId);
          const staleStr = stale ? " [stale -- agent offline]" : "";
          const work = renderAgentWorkState(res.agentId, backlog);
          const workStr = work ? ` (${work})` : ` (${duration})`;
          const isMe = res.agentId === ctx.agentId;
          const marker = isMe ? " (you)" : "";
          return `  ${path}  →  ${res.agent}${marker}${taskStr}${reasonStr}${workStr}${staleStr}`;
        });
        return { text: `Active reservations:\n${lines.join("\n")}`, details: { reservations } };
      }
      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  },
};

// ─── amux_journal ────────────────────────────────────────────

const JOURNAL_ACTIONS = ["add", "list"] as const;
const JOURNAL_TYPES = ["decision", "learning", "progress"] as const;
type JournalAction = typeof JOURNAL_ACTIONS[number];
type JournalType = typeof JOURNAL_TYPES[number];

interface JournalParams {
  action: JournalAction;
  type?: JournalType;
  content?: string;
  context?: string;
  limit?: number;
}

export const journalTool: AmuxToolDefinition<JournalParams> = {
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
  inputSchema: objectSchema(
    {
      action: enumProp(JOURNAL_ACTIONS, "Action to perform"),
      type: enumProp(JOURNAL_TYPES, "Journal entry type"),
      content: optionalStringProp("Journal entry content (required for add)"),
      context: optionalStringProp("Optional context (e.g., task ID, topic)"),
      limit: { type: "number", description: "Number of entries to show (default 20, for list)" },
    },
    ["action"],
  ),

  async execute(ctx, params): Promise<AmuxToolResult> {
    switch (params.action) {
      case "add": {
        if (!params.type) throw new Error("Entry type is required for add (decision, learning, or progress).");
        if (!params.content) throw new Error("Content is required for add.");
        const entry: JournalEntry = {
          timestamp: new Date().toISOString(),
          agent: ctx.agentName,
          agentId: ctx.agentId,
          type: params.type,
          content: params.content,
          context: params.context,
        };
        addJournalEntry(ctx.session, entry);
        return { text: `✓ Journal entry added: ${formatJournalEntry(entry)}`, details: { entry } };
      }
      case "list": {
        const limit = params.limit ?? 20;
        const entries = readJournalEntries(ctx.session, limit, params.type);
        if (entries.length === 0) {
          const typeNote = params.type ? ` of type "${params.type}"` : "";
          return { text: `No journal entries found${typeNote}.`, details: { entries: [] } };
        }
        const lines = entries.map((e) => `  ${formatJournalEntry(e)}`);
        const typeNote = params.type ? ` (${params.type})` : "";
        return { text: `Journal${typeNote} (${entries.length} entries):\n\n${lines.join("\n")}`, details: { entries } };
      }
      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  },
};
