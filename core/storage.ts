/**
 * amux — Shared Storage Layer
 *
 * Single source of truth for session directory resolution and atomic file I/O.
 * All core modules import path helpers and I/O functions from here.
 *
 * Session root priority:
 *   1. AMUX_SESSIONS_DIR  — explicit sessions directory path
 *   2. AMUX_HOME/sessions — custom amux home with /sessions appended
 *   3. ~/.amux/sessions   — default
 *
 * Environment variables are read on every call so tests and embedders
 * can override the root at any point before calling core functions.
 */

import { readFile, writeFile, rename, mkdir, readdir, open, stat, unlink } from "node:fs/promises";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Session Root Resolution ────────────────────────────────

/**
 * Resolve the amux sessions directory.
 *
 * Reads environment variables on every call so callers can
 * set `AMUX_SESSIONS_DIR` or `AMUX_HOME` before invoking
 * any core function (useful for tests and embedded usage).
 *
 * Priority:
 *   1. AMUX_SESSIONS_DIR  — full path to sessions directory
 *   2. AMUX_HOME/sessions — custom amux home root
 *   3. ~/.amux/sessions   — default
 */
export function getSessionsDir(): string {
  if (process.env.AMUX_SESSIONS_DIR) return process.env.AMUX_SESSIONS_DIR;
  if (process.env.AMUX_HOME) return join(process.env.AMUX_HOME, "sessions");
  return join(homedir(), ".amux", "sessions");
}

/** Get the directory path for a specific session. */
export function sessionDir(session: string): string {
  return join(getSessionsDir(), session);
}

/** Get the path to a file (or nested path) within a session directory. */
export function sessionFile(session: string, ...segments: string[]): string {
  return join(getSessionsDir(), session, ...segments);
}

// ─── Async JSON I/O ─────────────────────────────────────────

/** Read and parse a JSON file, returning fallback on any error. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write JSON to a file (write to tmp, then rename). */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

// ─── Sync JSONL I/O ─────────────────────────────────────────

/**
 * Read a JSONL file and return parsed entries.
 * Skips malformed lines. Returns empty array if the file doesn't exist.
 */
export function readJsonlSync<T>(path: string): T[] {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((e): e is T => e !== null);
}

/**
 * Append a JSON entry as a line to a JSONL file.
 * Creates parent directories if needed.
 */
export function appendJsonlSync(path: string, entry: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/** Ensure a directory exists (synchronous). */
export function ensureDirSync(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

// ─── Shared Display / Read Helpers ─────────────────────────

/**
 * Compact a text blob to a single-line preview of at most `maxLength` chars.
 *
 * Collapses whitespace (including newlines/tabs) to single spaces, trims, and
 * appends an ellipsis if the result still exceeds `maxLength`. The canonical
 * implementation for all one-line previews (message/comment/post). Re-export
 * thin wrappers (messagePreview / taskCommentPreview / postPreview) live in
 * their domain modules for call-site clarity.
 */
export function truncatePreview(text: string, maxLength = 160): string {
  const compact = text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

/**
 * Format an ISO 8601 timestamp as a compact "YYYY-MM-DD HH:MM" string.
 * The canonical display format for all human-readable timestamps (comments,
 * journal entries, discussion posts). Centralized so the policy lives in one
 * place and is reused by both low-level domain modules and renderers.
 */
export function formatTimestamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * Read a text file and cap its length, returning null if it is missing.
 *
 * Standardizes the read-with-size-guard pattern used by spec/context/WoW
 * previews. When truncation occurs, appends a path-aware suffix so the reader
 * knows where to find the full file (the bodies-on-demand convention).
 * Malformed/missing files return null rather than throwing.
 */
export function readCappedFile(path: string, maxChars: number): string | null {
  if (!existsSync(path)) return null;
  try {
    let content = readFileSync(path, "utf8").trim();
    if (maxChars > 0 && content.length > maxChars) {
      content = content.slice(0, maxChars) + `\n\n[truncated -- see full file at ${path}]`;
    }
    return content || null;
  } catch {
    return null;
  }
}

// ─── Coordinated Read-Modify-Write ──────────────────────────

const LOCK_STALE_MS = 30_000; // consider lock stale after 30s
const LOCK_MAX_RETRIES = 20;
const LOCK_RETRY_BASE_MS = 15; // base retry delay (jittered)

/**
 * Acquire an exclusive lock file using O_CREAT|O_EXCL (atomic on all platforms).
 * Retries with jittered backoff. Forcibly removes stale locks.
 */
async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY — fails atomically if file exists
      const fh = await open(lockPath, "wx");
      await fh.close();
      return;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;

      // Check for stale lock (e.g. process crashed while holding it)
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          try {
            await unlink(lockPath);
          } catch {
            /* another process may have cleaned it */
          }
          continue; // retry immediately after removing stale lock
        }
      } catch {
        // Lock was released between our check — retry
        continue;
      }

      if (attempt === LOCK_MAX_RETRIES) {
        throw new Error(`Failed to acquire lock: ${lockPath} (after ${LOCK_MAX_RETRIES} retries)`);
      }

      // Wait with jitter before retrying
      const delay = LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Already cleaned up
  }
}

/**
 * Perform a coordinated read-modify-write on a JSON file.
 *
 * Acquires an exclusive lock, reads the current state, passes it to
 * the `mutate` callback, writes the result atomically, and releases
 * the lock. If `mutate` throws, the file is left unchanged and the
 * error propagates to the caller.
 *
 * Safe for concurrent calls from multiple agents/processes operating
 * on the same session file.
 */
export async function withJsonFile<T>(
  path: string,
  fallback: T,
  mutate: (data: T) => T | Promise<T>,
): Promise<T> {
  const lockPath = path + ".lock";
  // Ensure parent directory exists before lock attempt
  await mkdir(dirname(path), { recursive: true });
  await acquireLock(lockPath);
  try {
    const data = await readJson<T>(path, fallback);
    const result = await mutate(data);
    await atomicWriteJson(path, result);
    return result;
  } finally {
    await releaseLock(lockPath);
  }
}

// ─── Session Discovery ──────────────────────────────────────

/** List all session directory names. Returns [] if sessions dir doesn't exist. */
export async function listSessions(): Promise<string[]> {
  try {
    const entries = await readdir(getSessionsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
