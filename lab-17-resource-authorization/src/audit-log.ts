import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Action, DenyReason } from "./policy.js";

/** Where a decision was made: the per-operation capability step, a direct application call, or inside a tool. */
export type AuditChannel = "capability" | "application" | "tool";

interface AuditBase {
  at: string;
  requestId: string;
  actor: string;
  tenantId: string;
  /** Roles the directory reported at decision time — the state the decision was made against. */
  roles: string[];
  policyVersion: string;
  policySha256: string;
}

export interface DecisionAuditRecord extends AuditBase {
  kind: "decision";
  channel: Exclude<AuditChannel, "capability">;
  toolCallId?: string;
  action: Action;
  /** Only the identifier the caller named; never booking content. */
  resource: { bookingNo: string };
  requestedStatus?: string;
  decision: "allow" | "deny";
  reason?: DenyReason;
  matchedRole?: string;
}

export interface CapabilityAuditRecord extends AuditBase {
  kind: "capabilities";
  channel: "capability";
  /** The tool names the conversation offered the model for this operation (after today's roles were applied). */
  offeredTools: string[];
  decision: "allow" | "deny";
}

export type AuditRecord = DecisionAuditRecord | CapabilityAuditRecord;

export type AuditWriteLine = (line: string) => void | Promise<void>;

/**
 * One responsibility: append a record, or throw. Callers `await` it *before* letting an effect
 * proceed and do not catch — if a decision cannot be recorded, the effect does not happen
 * (fail closed), the same policy Lab 13 chose for `before_tool`.
 */
export class AuditLog {
  public constructor(private readonly writeLine: AuditWriteLine) {}

  public async record(record: AuditRecord): Promise<void> {
    await this.writeLine(JSON.stringify(record));
  }
}

export function createFileAuditLog(path: string): AuditLog {
  return new AuditLog(async (line) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  });
}

export async function readAuditLog(path: string): Promise<AuditRecord[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditRecord);
}
