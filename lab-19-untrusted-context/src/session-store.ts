import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type JsonlStorage, openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export { BACKGROUND_CONTEXT };

/**
 * One session is one JSONL storage directory, `<sessionsRoot>/<tenant>/<sessionId>`. The tenant is in
 * the path so a mix-up lands in the wrong tenant's directory rather than merely the wrong file — but
 * the directory is only where the data lives. Who may open it is decided by `SessionRegistry`, never
 * by whether a directory with that name happens to exist.
 */
export function sessionDirectory(sessionsRoot: string, tenantId: string, sessionId: string): string {
  if (tenantId.length === 0 || sessionId.length === 0) {
    throw new Error("tenant id and session id must not be empty");
  }
  return join(sessionsRoot, encodeURIComponent(tenantId), encodeURIComponent(sessionId));
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
 * `openNodeJsonlStorage` creates the directory on first use and reopens it afterwards with the same
 * call, so "created or reopened" is decided by looking first. pi-durable does no cross-process
 * locking: one process owns a storage at a time (and `ChatService` serializes requests per session
 * inside this process).
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
