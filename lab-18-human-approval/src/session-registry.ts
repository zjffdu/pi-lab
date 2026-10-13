import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  ownerSubject: string;
  createdAt: string;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.tenantId === "string" &&
    typeof candidate.ownerSubject === "string" &&
    typeof candidate.createdAt === "string"
  );
}

/**
 * The server-side authority on which session belongs to whom. A session ID that a client sends
 * is only a lookup key into this registry; it carries no authority. `find` answers `undefined`
 * both when the ID is unknown and when it belongs to another tenant or another owner in the same
 * tenant — callers cannot tell those cases apart, which is what keeps a denial from confirming
 * that someone else's session exists.
 *
 * Personal sessions only: exactly one owner per session. A shared conversation would need an
 * explicit membership model and is out of scope for this lab (README, "Not covered").
 *
 * With a `path`, records persist as append-only JSONL so a restarted server still knows who owns
 * which session; without one the registry is in-memory (tests).
 */
export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>();

  public constructor(private readonly path?: string) {
    if (path !== undefined && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const parsed: unknown = JSON.parse(line);
        if (!isSessionRecord(parsed)) throw new Error(`Invalid session registry line in ${path}`);
        this.records.set(parsed.sessionId, parsed);
      }
    }
  }

  public create(context: SecurityContext): SessionRecord {
    assertSecurityContext(context);
    const record: SessionRecord = {
      sessionId: randomUUID(),
      tenantId: context.tenantId,
      ownerSubject: context.subject,
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.sessionId, record);
    if (this.path !== undefined) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    }
    return record;
  }

  public find(context: SecurityContext, sessionId: string): SessionRecord | undefined {
    assertSecurityContext(context);
    const record = this.records.get(sessionId);
    if (!record) return undefined;
    if (record.tenantId !== context.tenantId || record.ownerSubject !== context.subject) return undefined;
    return record;
  }
}
