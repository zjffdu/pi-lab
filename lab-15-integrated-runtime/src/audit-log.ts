import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditPhase = "before_tool" | "after_tool";
export type AuditDecision = "allowed" | "blocked" | "executed" | "errored";

/**
 * One append-only audit line. `args` is built by the caller from an explicit allowlist of fields (see
 * `governance-hooks.ts`), never a raw spread of whatever the tool call carried, so this record can never
 * grow a secret field just because a future tool's arguments include one.
 *
 * Who supplies each identity (Pi 1.1; a hook is given no run id, no lane, and no turn id):
 * - Pi, from `HookApi`: `conversationId`, and `taskId` — the `pi.tool` task of this one call.
 * - Pi, from the call itself: `toolCallId`. The model chooses it, so it is unique only within one
 *   assistant message; `taskId` is what is unique in the session.
 * - The application: `sessionId` (storage knows no external session id), `requestId` (`null`, never a
 *   made-up value, when no request was in flight), and `businessActionId` for a tool that can change
 *   business state. The latter is derived from `conversationId` + `taskId`, which stay the same when a
 *   recovered process reruns the call.
 */
export interface AuditRecord {
  at: string;
  requestId: string | null;
  sessionId: string;
  conversationId: number;
  taskId: number;
  toolCallId: string;
  businessActionId?: string;
  toolName: string;
  phase: AuditPhase;
  decision: AuditDecision;
  reason?: string;
  args?: Record<string, string>;
}

export type AuditWriteLine = (line: string) => void | Promise<void>;

/**
 * Deliberately minimal: one method, one responsibility. The write function is injected so tests and
 * the failure experiments can substitute a throwing writer without touching the hooks — see
 * `tests/governance-pipeline.test.ts` and the README for what a throwing writer does to `beforeTool`
 * versus `afterTool`.
 */
/** Anything that can durably record one audit record. `AuditLog` is the file/memory implementation. */
export interface AuditSink {
  record(record: AuditRecord): Promise<void>;
}

export class AuditLog implements AuditSink {
  public constructor(private readonly writeLine: AuditWriteLine) {}

  public async record(record: AuditRecord): Promise<void> {
    await this.writeLine(JSON.stringify(record));
  }
}

/** In-memory sink for tests and demos. */
export function createMemoryAuditLog(): { auditLog: AuditLog; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const auditLog = new AuditLog((line) => {
    records.push(JSON.parse(line) as AuditRecord);
  });
  return { auditLog, records };
}

/**
 * Append-only JSONL sink at `path`. `appendFile` creates the *file* on first use but never its parent
 * directory, so this needs an explicit `mkdir(..., { recursive: true })` first, or the first write
 * fails with `ENOENT` on a fresh checkout.
 */
export function createFileLineWriter(path: string): AuditWriteLine {
  return async (line) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  };
}

export function createFileAuditLog(path: string): AuditLog {
  return new AuditLog(createFileLineWriter(path));
}

/** Read-only inspection helper: used by the CLI's `--inspect-audit` and by tests, never by the hooks. */
export async function readAuditLog(path: string): Promise<AuditRecord[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}
