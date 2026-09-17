import { describe, expect, it, vi } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";
import { ContainerEventsNotFoundError, createSlowContainerEventsTool } from "../src/slow-container-events-tool.js";

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

describe("get_container_events (slow harness tool)", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("fires the dispatch checkpoint before the artificial delay resolves", async () => {
    const dispatched: string[] = [];
    const tool = createSlowContainerEventsTool(repository, {
      delayMs: 20,
      onDispatch: (toolCallId) => dispatched.push(toolCallId),
    });

    const promise = tool.execute("call-1", { containerNo: "MSKU1234567" }, onUpdate, toolContext, invocation, context);

    // execute() runs synchronously up to its first `await` — the checkpoint has already
    // fired here even though the returned promise has not settled. This ordering is the
    // whole premise of Lab 08's failure injection: by the time this line is observable,
    // the assistant's tool-call is durable, and the artificial "work" has not started.
    expect(dispatched).toEqual(["call-1"]);

    const result = await promise;
    expect(result.details).toEqual({ containerNo: "MSKU1234567", eventCount: expect.any(Number) });
  });

  it("returns structured fixture evidence after the delay", async () => {
    const tool = createSlowContainerEventsTool(repository, { delayMs: 5 });

    const result = await tool.execute(
      "call-2",
      { containerNo: "MSKU1234567" },
      onUpdate,
      toolContext,
      invocation,
      context,
    );

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(repository.findByContainerNo("MSKU1234567")) },
    ]);
  });

  it("throws a typed error for a container with no events", async () => {
    const tool = createSlowContainerEventsTool(repository, { delayMs: 5 });

    await expect(
      tool.execute("call-3", { containerNo: "BAD_CONTAINER" }, onUpdate, toolContext, invocation, context),
    ).rejects.toEqual(new ContainerEventsNotFoundError("BAD_CONTAINER"));
  });
});
