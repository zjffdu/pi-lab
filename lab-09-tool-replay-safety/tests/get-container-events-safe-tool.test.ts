import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";
import { ContainerEventRepository } from "../src/container-event-repository.js";
import { ContainerEventsNotFoundError, createGetContainerEventsSafeTool } from "../src/get-container-events-safe-tool.js";

const onUpdate = vi.fn();
const toolContext = undefined;
const invocation = {
  invocationId: "invocation-1",
  operationId: "operation-1",
  turnId: "turn-1",
  getMemo: vi.fn(),
  setMemo: vi.fn(),
};
const context = { abortSignal: undefined } as never;

let dir: string;
let attemptLog: AttemptLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-09-safe-tool-"));
  attemptLog = new AttemptLog(join(dir, "attempts.jsonl"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("get_container_events (safe-replay harness tool)", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("declares replay: \"safe\"", () => {
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5 });
    expect(tool.replay).toBe("safe");
  });

  it("fires the dispatch checkpoint and records the attempt before the artificial delay resolves", async () => {
    const dispatched: string[] = [];
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, {
      delayMs: 20,
      onDispatch: (toolCallId) => dispatched.push(toolCallId),
    });

    const promise = tool.execute("call-1", { containerNo: "MSKU1234567" }, onUpdate, toolContext, invocation, context);

    // execute() runs synchronously up to its first `await` — the checkpoint and the
    // attempt-log write have already happened here even though the returned promise has
    // not settled.
    expect(dispatched).toEqual(["call-1"]);
    expect(attemptLog.readAll()).toEqual([
      { tool: "get_container_events", toolCallId: "call-1", invocationId: "invocation-1", detail: "MSKU1234567", at: expect.any(Number) },
    ]);

    const result = await promise;
    expect(result.details).toEqual({ containerNo: "MSKU1234567", eventCount: expect.any(Number) });
  });

  it("records one attempt per real execute() call, even for the same logical invocationId", async () => {
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5 });

    await tool.execute("call-1", { containerNo: "MSKU1234567" }, onUpdate, toolContext, invocation, context);
    await tool.execute("call-1", { containerNo: "MSKU1234567" }, onUpdate, toolContext, invocation, context);

    const attempts = attemptLog.readAll();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.invocationId).toBe(attempts[1]?.invocationId);
  });

  it("throws a typed error for a container with no events", async () => {
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5 });

    await expect(
      tool.execute("call-3", { containerNo: "BAD_CONTAINER" }, onUpdate, toolContext, invocation, context),
    ).rejects.toEqual(new ContainerEventsNotFoundError("BAD_CONTAINER"));
  });
});
