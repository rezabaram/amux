/**
 * Project context / vision helpers.
 *
 * Project context is the first alignment artifact for an amux session.
 * It is stored as Markdown in artifacts/project/CONTEXT.md and injected
 * into agent prompts by adapters.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirSync, sessionFile } from "./storage.ts";

export const PROJECT_CONTEXT_FILENAME = "CONTEXT.md";
export const DEFAULT_CONTEXT_PREVIEW_LIMIT = 4096;

export function projectArtifactsPath(session: string): string {
  return sessionFile(session, "artifacts", "project");
}

export function projectContextPath(session: string): string {
  return join(projectArtifactsPath(session), PROJECT_CONTEXT_FILENAME);
}

export function readProjectContext(
  session: string,
  maxLength = DEFAULT_CONTEXT_PREVIEW_LIMIT,
): string | null {
  const path = projectContextPath(session);
  if (!existsSync(path)) return null;
  try {
    let content = readFileSync(path, "utf8").trim();
    if (maxLength > 0 && content.length > maxLength) {
      content = content.slice(0, maxLength) + `\n\n[truncated -- see full file at ${path}]`;
    }
    return content || null;
  } catch {
    return null;
  }
}

export function writeProjectContext(session: string, content: string): string {
  const path = projectContextPath(session);
  ensureDirSync(projectArtifactsPath(session));
  writeFileSync(path, content, "utf8");
  return path;
}

export function appendProjectContext(session: string, content: string): string {
  const current = readProjectContext(session, 0) || "";
  return writeProjectContext(session, current + (current ? "\n\n" : "") + content);
}

export function clearProjectContext(session: string): string {
  return writeProjectContext(session, "");
}
