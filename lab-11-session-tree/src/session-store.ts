import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type JsonlStorage, openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export { BACKGROUND_CONTEXT };

/**
 * One session is one JSONL storage directory under `sessionsRoot`, named after the session id.
 * The directory is the whole identity: there is no separate index, no grouping key, and no
 * per-process registry. Two ids can never share a directory, and an id that was never used
 * simply has no directory yet.
 */
export function sessionDirectory(sessionsRoot: string, sessionId: string): string {
  if (sessionId.length === 0) {
    throw new Error("session id must not be empty");
  }
  return join(sessionsRoot, encodeURIComponent(sessionId));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export interface OpenedSessionStorage {
  storage: JsonlStorage;
  /** True when this call created the storage directory; false when it reopened an existing one. */
  created: boolean;
  path: string;
}

/**
 * `openNodeJsonlStorage` creates the directory on first use and reopens it afterwards with
 * the same call, so "created or reopened" is decided here by looking before opening. One
 * process owns a storage at a time; pi-durable does no cross-process locking.
 */
export async function openSessionStorage(
  sessionsRoot: string,
  sessionId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<OpenedSessionStorage> {
  const path = sessionDirectory(sessionsRoot, sessionId);
  const created = !(await directoryExists(path));
  const storage = await openNodeJsonlStorage(path, context);
  return { storage, created, path };
}
