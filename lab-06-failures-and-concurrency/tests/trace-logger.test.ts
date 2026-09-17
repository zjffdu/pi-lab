import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createResilienceTraceLogger } from "../src/trace-logger.js";

describe("createResilienceTraceLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tags every line with the conversation id, turn number, and a monotonic elapsed time", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1000); // agent_start
    now.mockReturnValueOnce(1005); // turn_start
    now.mockReturnValueOnce(1010); // tool_execution_start
    now.mockReturnValueOnce(1040); // tool_execution_end
    now.mockReturnValueOnce(1042); // agent_end

    const lines: string[] = [];
    const log = createResilienceTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "get_booking",
      args: { bookingNo: "BK1001" },
    });
    log({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "get_booking",
      result: {},
      isError: false,
    });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "[Pi][conversation-a] t=+0.00ms turn=0 agent_start",
      "[Pi][conversation-a] t=+5.00ms turn=1 turn_start",
      '[Tool][conversation-a] t=+10.00ms turn=1 id=call-1 start get_booking args={"bookingNo":"BK1001"}',
      "[Tool][conversation-a] t=+40.00ms turn=1 id=call-1 end get_booking status=success",
      "[Pi][conversation-a] t=+42.00ms turn=1 agent_end",
    ]);
  });

  it("does not go backwards even if the wall clock is set back mid-run", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(5000); // agent_start
    now.mockReturnValueOnce(5050); // turn_start, still monotonic even though a wall clock would not be

    const lines: string[] = [];
    const log = createResilienceTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });

    expect(lines).toEqual([
      "[Pi][conversation-a] t=+0.00ms turn=0 agent_start",
      "[Pi][conversation-a] t=+50.00ms turn=1 turn_start",
    ]);
  });

  it("shows a parallel tool batch's toolCallId, source order, and transcript order together", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0); // agent_start
    now.mockReturnValueOnce(0); // turn_start
    now.mockReturnValueOnce(10); // call-a start
    now.mockReturnValueOnce(15); // call-b start
    now.mockReturnValueOnce(60); // call-b end (finishes first)
    now.mockReturnValueOnce(120); // call-a end
    now.mockReturnValueOnce(121); // turn_end

    const lines: string[] = [];
    const log = createResilienceTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "get_container_events",
      args: { containerNo: "MSKU1234567" },
    });
    log({
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "get_port_status",
      args: { portCode: "CNSHA" },
    });
    log({
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "get_port_status",
      result: {},
      isError: false,
    });
    log({
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "get_container_events",
      result: {},
      isError: false,
    });

    const turnEnd = {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "get_container_events", arguments: {} },
          { type: "toolCall", id: "call-b", name: "get_port_status", arguments: {} },
        ],
      },
      toolResults: [
        { toolCallId: "call-a", toolName: "get_container_events" },
        { toolCallId: "call-b", toolName: "get_port_status" },
      ],
    } as unknown as AgentEvent;
    log(turnEnd);

    expect(lines).toContain(
      "[Timeline][conversation-a]   id=call-a get_container_events source=0 transcript=0 " +
        "start=+10.00ms end=+120.00ms duration=110.00ms",
    );
    expect(lines).toContain(
      "[Timeline][conversation-a]   id=call-b get_port_status source=1 transcript=1 " +
        "start=+15.00ms end=+60.00ms duration=45.00ms",
    );
  });
});
