import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type Context,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export { BACKGROUND_CONTEXT };

/**
 * One JSONL repository rooted at `sessionsRoot`. The repo does not need `sessionsRoot` to
 * exist yet — `create()` makes the directory on first use.
 */
export function createSessionRepo(sessionsRoot: string): JsonlSessionRepo {
  const fileSystem = new NodeExecutionEnv({ cwd: sessionsRoot });
  return new JsonlSessionRepo({ fileSystem, sessionsRoot });
}

export interface OpenOrCreateResult {
  session: Session<JsonlSessionMetadata>;
  created: boolean;
}

/**
 * `JsonlSessionRepo` groups session files on disk by a `(cwd, id)` pair, not by `id`
 * alone — `cwd` is the repo's own logical grouping key, unrelated to this process's
 * actual working directory. Callers must pass the exact same `cwd` string on every
 * invocation that should be able to find the same session again; this lab uses one fixed
 * constant (see `SESSION_GROUP` in `cli.ts`) so a session id resolves the same way
 * regardless of the shell directory the CLI happens to be run from.
 *
 * Reopening is a two-step lookup because the repo's `open()` needs full metadata (the
 * exact file path, not just the id) — `list()` is how you recover that metadata for an
 * id you already know.
 */
export async function openOrCreateSession(
  repo: JsonlSessionRepo,
  id: string,
  cwd: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<OpenOrCreateResult> {
  const existing = await repo.list({ cwd }, context);
  const metadata = existing.find((candidate) => candidate.id === id);

  if (metadata) {
    return { session: await repo.open(metadata, context), created: false };
  }

  return { session: await repo.create({ id, cwd }, context), created: true };
}
