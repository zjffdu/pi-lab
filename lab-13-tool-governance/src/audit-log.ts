import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditPhase = "before_tool" | "after_tool";
export type AuditDecision = "allowed" | "blocked" | "executed" | "errored";

/**
 * One append-only audit line. `args` is built by the caller from an explicit allowlist of fields
 * (see `governance-hooks.ts`), never a raw spread of whatever the tool call carried, so this record
 * can never grow a secret field just because a future tool's arguments include one.
 *
 * The correlation ids are exactly what a `beforeTool`/`afterTool` hook is given and nothing more:
 * `conversationId` and `taskId` (the `pi.tool` task of this one call) from `HookApi`, `toolCallId` from
 * the call itself, and `sessionId`, which the application supplies because storage knows no external
 * session id. The hook gets no run id, no lane, and no turn id; the README's "Joining an audit record to
 * the transcript" shows how each is recovered from durable entries.
 */
export interface AuditRecord {
  at: string;
  sessionId: string;
  conversationId: number;
  taskId: number;
  toolCallId: string;
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
export class AuditLog {
  public constructor(private readonly writeLine: AuditWriteLine) {}

  public async record(record: AuditRecord): Promise<void> {
    await this.writeLine(JSON.stringify(record));
  }
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
