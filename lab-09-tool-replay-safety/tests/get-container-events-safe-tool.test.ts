import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";
import { ContainerEventRepository } from "../src/container-event-repository.js";
import { ContainerEventsNotFoundError, createGetContainerEventsSafeTool } from "../src/get-container-events-safe-tool.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";

// A harness hands `execute` a real `api` (taskId, callId, ...) when it runs the call as a durable
// task. The tool only reads `taskId` and `callId`, to announce and record itself.
const api = { taskId: 12, callId: "call-1" } as never;

let dir: string;
let attemptLog: AttemptLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-09-safe-tool-"));
  attemptLog = new AttemptLog(join(dir, "attempts.jsonl"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("get_container_events (safe-replay pi-durable tool)", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it('declares replay: "safe"', () => {
    expect(createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5 }).replay).toBe("safe");
  });

  it("records the attempt and fires the dispatch checkpoint before the artificial delay resolves", async () => {
    const dispatched: unknown[] = [];
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, {
      delayMs: 20,
      onDispatch: (dispatch) => dispatched.push(dispatch),
    });

    const promise = tool.execute({ containerNo: "MSKU1234567" }, api, BACKGROUND_CONTEXT);

    // execute() runs synchronously up to its first `await`: the attempt is already on disk and the
    // checkpoint already fired, though the returned promise has not settled. A SIGKILL right here
    // leaves exactly this evidence behind.
    expect(dispatched).toEqual([{ taskId: "12", callId: "call-1", containerNo: "MSKU1234567" }]);
    expect(attemptLog.readAll()).toEqual([
      { tool: "get_container_events", callId: "call-1", taskId: "12", detail: "MSKU1234567", at: expect.any(Number) },
    ]);

    const result = await promise;
    expect(result.details).toEqual({ containerNo: "MSKU1234567", eventCount: 3 });
  });

  it("returns structured fixture evidence for the second container of a booking", async () => {
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5, onDispatch: () => {} });

    const result = await tool.execute({ containerNo: "MSKU2345678" }, api, BACKGROUND_CONTEXT);

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(repository.findByContainerNo("MSKU2345678")) },
    ]);
  });

  it("throws a typed error for a container with no events", async () => {
    const tool = createGetContainerEventsSafeTool(repository, attemptLog, { delayMs: 5, onDispatch: () => {} });

    await expect(tool.execute({ containerNo: "BAD_CONTAINER" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new ContainerEventsNotFoundError("BAD_CONTAINER"),
    );
  });
});
