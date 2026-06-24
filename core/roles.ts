/**
 * amux — Role Profiles and Team Templates
 *
 * Bundled role profile markdown and team templates, plus helpers to copy
 * them into project artifacts and resolve role instructions.
 *
 * Project-local role profiles live under artifacts/project/roles/<name>.md
 * and are the source of truth for an agent's prompt when RoleDefinition.profilePath
 * is set. Roles without profilePath fall back to stored inline instructions.
 *
 * Pi-independent — file-based, no framework coupling.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sessionFile } from "./storage.ts";
import { type RoleDefinition, addRole } from "./registry.ts";

// ─── Bundled Template Paths ──────────────────────────────────

const moduleDir = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROLES_DIR = join(moduleDir, "..", "roles");
const BUNDLED_TEMPLATES_DIR = join(moduleDir, "..", "team-templates");

// ─── Types ───────────────────────────────────────────────────

export interface TeamTemplateRole {
  name: string; // role definition name
  template: string; // bundled role markdown template
  agentName?: string; // suggested agent name (shown during separate agent creation)
  workspace?: string; // suggested workspace policy (advisory only)
}

export interface TeamTemplate {
  name: string;
  description: string;
  roles: TeamTemplateRole[];
}

// Built-in role definitions used as initial/default role choices.
export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    name: "developer",
    description: "Write clean, well-structured code",
    instructions:
      "You are a software developer. Focus on writing clean, well-structured code. Follow best practices for the project's language and framework. Write tests when appropriate. Read existing code before making changes to understand patterns and conventions. Coordinate with other agents when your changes affect shared interfaces.",
  },
  {
    name: "architect",
    description: "System design, trade-offs, technical decisions",
    instructions:
      "You are a software architect. Focus on system design, high-level structure, and technical decision-making. Evaluate trade-offs between approaches. Define interfaces, data models, and component boundaries. Review code for architectural consistency. Guide other agents on design patterns, project organization, and scalability concerns. Think about maintainability, extensibility, and separation of concerns.",
  },
  {
    name: "reviewer",
    description: "Code review, quality, constructive feedback",
    instructions:
      "You are a code reviewer. Review code for correctness, clarity, performance, and adherence to project conventions. Provide constructive, specific feedback. Identify potential bugs, security issues, and edge cases. Suggest improvements without being prescriptive. Approve when quality standards are met.",
  },
  {
    name: "devops",
    description: "Infrastructure, CI/CD, deployment",
    instructions:
      "You are a DevOps engineer. Manage infrastructure, CI/CD pipelines, deployment scripts, and configuration. Focus on reliability, security, and automation. Monitor for performance issues. Write infrastructure as code. Ensure environments are reproducible and deployments are safe.",
  },
  {
    name: "planner",
    description: "Task breakdown, requirements, coordination",
    instructions:
      "You are a project planner. Break down features into actionable tasks with clear descriptions. Define requirements and acceptance criteria in task descriptions. Coordinate work across agents. Track progress and identify blockers. Keep the backlog organized and prioritized.",
  },
];

/** Check if a role name matches a built-in role definition. */
export function isBuiltinRole(name: string): boolean {
  return BUILTIN_ROLES.some((role) => role.name === name);
}

// ─── Bundled Template Discovery ──────────────────────────────

/** List available bundled role profile template names (without .md). */
export function listRoleTemplates(): string[] {
  try {
    return readdirSync(BUNDLED_ROLES_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Read a bundled role template's markdown content, or null if missing. */
export function readRoleTemplate(templateName: string): string | null {
  const path = join(BUNDLED_ROLES_DIR, `${templateName}.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** List available bundled team templates. */
export function listTeamTemplates(): TeamTemplate[] {
  try {
    return readdirSync(BUNDLED_TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(BUNDLED_TEMPLATES_DIR, f), "utf8")) as TeamTemplate;
        } catch {
          return null;
        }
      })
      .filter((t): t is TeamTemplate => t !== null);
  } catch {
    return [];
  }
}

/** Get a single bundled team template by name, or null. */
export function getTeamTemplate(name: string): TeamTemplate | null {
  return listTeamTemplates().find((t) => t.name === name) ?? null;
}

// ─── Project-Local Profile Paths ─────────────────────────────

/** Conventional relative path for a project-local role profile. */
export function roleProfileRelPath(roleName: string): string {
  return `roles/${roleName}.md`;
}

/** Resolve a role profile relative path to a full session path. */
export function roleProfileFullPath(session: string, relPath: string): string {
  return sessionFile(session, "artifacts", "project", relPath);
}

// ─── Description Extraction ──────────────────────────────────

/** Extract a short description from role markdown (first heading or Mission line). */
function extractDescription(content: string): string {
  const lines = content.split("\n");
  // Prefer the line after a "## Mission" heading
  const missionIdx = lines.findIndex((l) => /^##\s+Mission/i.test(l));
  if (missionIdx >= 0) {
    for (let i = missionIdx + 1; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t) return t.slice(0, 100);
    }
  }
  // Fall back to first H1
  const h1 = lines.find((l) => /^#\s+/.test(l));
  if (h1) return h1.replace(/^#\s+/, "").trim();
  return "";
}

// ─── Copy + Apply ────────────────────────────────────────────

/**
 * Copy a bundled role template into project artifacts.
 * Does NOT overwrite an existing customized file unless force is true.
 * Returns the relative profilePath, or null if the template doesn't exist.
 */
export function copyRoleProfile(
  session: string,
  templateName: string,
  roleName: string,
  force = false,
): string | null {
  const content = readRoleTemplate(templateName);
  if (content === null) return null;

  const relPath = roleProfileRelPath(roleName);
  const fullPath = roleProfileFullPath(session, relPath);

  if (existsSync(fullPath) && !force) {
    return relPath; // preserve customized file
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return relPath;
}

/**
 * Resolve an agent's role instructions.
 * If profilePath is set and the file exists, the markdown file is the source
 * of truth. Otherwise fall back to stored inline instructions.
 */
export function resolveRoleInstructions(session: string, role: RoleDefinition): string {
  if (role.profilePath) {
    const fullPath = roleProfileFullPath(session, role.profilePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8").trim();
        if (content) return content;
      } catch {
        // fall through to stored instructions
      }
    }
  }
  return role.instructions;
}

/**
 * Apply a team template: copy role profiles into the project and register
 * role definitions. Roles only — does NOT create agents or workspaces.
 * Existing customized role files are preserved unless force is true.
 *
 * @returns The applied role names and the template, or null if not found.
 */
export async function applyTeamTemplate(
  session: string,
  templateName: string,
  force = false,
): Promise<{ applied: string[]; template: TeamTemplate } | null> {
  const template = getTeamTemplate(templateName);
  if (!template) return null;

  const applied: string[] = [];
  for (const spec of template.roles) {
    const content = readRoleTemplate(spec.template);
    if (content === null) continue;

    const relPath = copyRoleProfile(session, spec.template, spec.name, force);
    if (!relPath) continue;

    await addRole(session, {
      name: spec.name,
      description: extractDescription(content),
      instructions: content.trim(), // cached fallback; profilePath is source of truth
      profilePath: relPath,
      templateName: spec.template,
    });
    applied.push(spec.name);
  }

  return { applied, template };
}
