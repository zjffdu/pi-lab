import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutboxRepository } from "../src/outbox-repository.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-09-outbox-"));
  filePath = join(dir, "nested", "outbox.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OutboxRepository", () => {
  it("starts empty when the file does not exist yet", () => {
    const outbox = new OutboxRepository(filePath);
    expect(outbox.readAll()).toEqual([]);
  });

  it("creates missing parent directories and appends one JSON line per record", () => {
    const outbox = new OutboxRepository(filePath);
    outbox.appendSync({ taskId: "task-1", callId: "call-1", bookingNo: "BK1001", reason: "customs review", holdId: "hold-task-task-1", at: 1 });

    expect(outbox.readAll()).toEqual([
      { taskId: "task-1", callId: "call-1", bookingNo: "BK1001", reason: "customs review", holdId: "hold-task-task-1", at: 1 },
    ]);
  });

  it("never collapses two distinct appends into one record", () => {
    const outbox = new OutboxRepository(filePath);
    outbox.appendSync({ taskId: "task-1", callId: "call-1", bookingNo: "BK1001", reason: "customs review", holdId: "hold-task-task-1", at: 1 });
    outbox.appendSync({ taskId: "task-2", callId: "call-2", bookingNo: "BK1001", reason: "customs review", holdId: "hold-task-task-2", at: 2 });

    expect(outbox.readAll()).toHaveLength(2);
  });

  it("reset() removes the file, and readAll() reports empty again", () => {
    const outbox = new OutboxRepository(filePath);
    outbox.appendSync({ taskId: "task-1", callId: "call-1", bookingNo: "BK1001", reason: "customs review", holdId: "hold-task-task-1", at: 1 });

    outbox.reset();
    expect(outbox.readAll()).toEqual([]);
  });
});
