import { describe, expect, it } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { ContainerEventsNotFoundError, createSlowContainerEventsTool } from "../src/slow-container-events-tool.js";

// A harness hands `execute` a real `api` (taskId, callId, streamed output, ...) when it runs the call
// as a durable task. The tool only reads `taskId` and `callId`, to announce itself.
const api = { taskId: "task-1", callId: "call-1" } as never;

describe("get_container_events (slow pi-durable tool)", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("fires the dispatch checkpoint before the artificial delay resolves", async () => {
    const dispatched: { taskId: string; callId: string; containerNo: string }[] = [];
    const tool = createSlowContainerEventsTool(repository, { delayMs: 20, onDispatch: (d) => dispatched.push(d) });

    const promise = tool.execute({ containerNo: "MSKU1234567" }, api, BACKGROUND_CONTEXT);

    // execute() runs synchronously up to its first `await`: the checkpoint has already fired here
    // even though the returned promise has not settled. That ordering is the whole premise of
    // Lab 08's failure injection: the call is announced (and, in a harness, already durable)
    // while its outcome is still pending.
    expect(dispatched).toEqual([{ taskId: "task-1", callId: "call-1", containerNo: "MSKU1234567" }]);

    const result = await promise;
    expect(result.details).toEqual({ containerNo: "MSKU1234567", eventCount: 3 });
  });

  it("returns structured fixture evidence after the delay", async () => {
    const tool = createSlowContainerEventsTool(repository, { delayMs: 5, onDispatch: () => {} });

    const result = await tool.execute({ containerNo: "MSKU2345678" }, api, BACKGROUND_CONTEXT);

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(repository.findByContainerNo("MSKU2345678")) },
    ]);
  });

  it("throws a typed error for a container with no events", async () => {
    const tool = createSlowContainerEventsTool(repository, { delayMs: 5, onDispatch: () => {} });

    await expect(tool.execute({ containerNo: "BAD_CONTAINER" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new ContainerEventsNotFoundError("BAD_CONTAINER"),
    );
  });
});
