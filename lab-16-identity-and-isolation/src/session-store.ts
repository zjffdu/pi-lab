import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type JsonlStorage, openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export { BACKGROUND_CONTEXT };

function pathSegment(label: string, value: string): string {
  // `encodeURIComponent` leaves "." and ".." alone, and either would climb out of its parent directory.
  if (value === "" || value === "." || value === "..") {
    throw new Error(`${label} is not usable as a directory name`);
  }
  return encodeURIComponent(value);
}

/**
 * One session is one JSONL storage directory, `<sessionsRoot>/<tenant>/<sessionId>`. The tenant level
 * means a mix-up lands in the wrong tenant's directory rather than merely beside a stranger's file — but
 * the directory layout is bookkeeping, not the access decision: `SessionRegistry` decides who may open a
 * session, and this function is only ever called with a session the registry already approved.
 */
export function sessionDirectory(sessionsRoot: string, tenantId: string, sessionId: string): string {
  return join(sessionsRoot, pathSegment("tenant id", tenantId), pathSegment("session id", sessionId));
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
 * `openNodeJsonlStorage` creates the directory (and its parents) on first use and reopens it afterwards
 * with the same call, so "created or reopened" is decided here by looking first. One process owns a
 * storage at a time; pi-durable does no cross-process locking.
 */
export async function openSessionStorage(
  sessionsRoot: string,
  tenantId: string,
  sessionId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<OpenedSessionStorage> {
  const path = sessionDirectory(sessionsRoot, tenantId, sessionId);
  const created = !(await directoryExists(path));
  const storage = await openNodeJsonlStorage(path, context);
  return { storage, created, path };
}
