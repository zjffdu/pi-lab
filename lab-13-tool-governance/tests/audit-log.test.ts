import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog, createFileAuditLog, readAuditLog, type AuditRecord } from "../src/audit-log.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-13-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE: AuditRecord = {
  at: "2026-09-18T00:00:00.000Z",
  sessionId: "session-1",
  conversationId: 1,
  taskId: 12,
  toolCallId: "call-1",
  toolName: "update_booking_status",
  phase: "before_tool",
  decision: "blocked",
  reason: "Cancellation is not permitted through update_booking_status in this lab.",
  args: { bookingNo: "BK1001", newStatus: "cancelled" },
};

describe("createFileAuditLog / readAuditLog", () => {
  it("is append-only: two records land as two JSONL lines, in order, and read back losslessly", async () => {
    const path = join(dir, "audit-log.jsonl");
    const log = createFileAuditLog(path);

    await log.record(SAMPLE);
    await log.record({ ...SAMPLE, toolCallId: "call-2", decision: "allowed", reason: undefined });

    const records = await readAuditLog(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(SAMPLE);
    expect(records[1]?.toolCallId).toBe("call-2");
    expect(records[1]?.decision).toBe("allowed");
  });

  it("creates a not-yet-existing parent directory on first write, instead of failing with ENOENT", async () => {
    const path = join(dir, "nested", "does-not-exist-yet", "audit-log.jsonl");
    await createFileAuditLog(path).record(SAMPLE);
    expect(await readAuditLog(path)).toEqual([SAMPLE]);
  });

  it("readAuditLog returns an empty array for a file that does not exist yet, instead of throwing", async () => {
    expect(await readAuditLog(join(dir, "never-written.jsonl"))).toEqual([]);
  });

  it("carries the correlation ids a hook is really given — and no run, lane, or turn id", async () => {
    const path = join(dir, "audit-log.jsonl");
    await createFileAuditLog(path).record(SAMPLE);
    const [record] = await readAuditLog(path);

    expect(Object.keys(record ?? {}).sort()).toEqual(
      ["args", "at", "conversationId", "decision", "phase", "reason", "sessionId", "taskId", "toolCallId", "toolName"].sort(),
    );
    expect(Object.keys(record?.args ?? {}).sort()).toEqual(["bookingNo", "newStatus"]);
  });
});

describe("AuditLog with an injected failing sink", () => {
  it("propagates the writer's own throw — what lets a hook's unguarded await turn an audit failure into the hook's own failure", async () => {
    const log = new AuditLog(() => {
      throw new Error("simulated disk failure");
    });
    await expect(log.record(SAMPLE)).rejects.toThrow("simulated disk failure");
  });
});
