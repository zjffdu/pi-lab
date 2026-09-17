import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-09-attempt-log-"));
  filePath = join(dir, "nested", "attempts.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AttemptLog", () => {
  it("starts empty when the file does not exist yet", () => {
    const log = new AttemptLog(filePath);
    expect(log.readAll()).toEqual([]);
  });

  it("creates missing parent directories and appends one JSON line per attempt", () => {
    const log = new AttemptLog(filePath);
    log.recordSync({ tool: "t", toolCallId: "call-1", invocationId: "inv-1", detail: "a", at: 1 });
    log.recordSync({ tool: "t", toolCallId: "call-1", invocationId: "inv-1", detail: "a", at: 2 });

    expect(log.readAll()).toEqual([
      { tool: "t", toolCallId: "call-1", invocationId: "inv-1", detail: "a", at: 1 },
      { tool: "t", toolCallId: "call-1", invocationId: "inv-1", detail: "a", at: 2 },
    ]);
  });

  it("reset() removes the file, and readAll() reports empty again", () => {
    const log = new AttemptLog(filePath);
    log.recordSync({ tool: "t", toolCallId: "call-1", invocationId: "inv-1", detail: "a", at: 1 });
    expect(log.readAll()).toHaveLength(1);

    log.reset();
    expect(log.readAll()).toEqual([]);
  });
});
