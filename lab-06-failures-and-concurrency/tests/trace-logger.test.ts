import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createResilienceTraceLogger } from "../src/trace-logger.js";

describe("createResilienceTraceLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tags every line with the conversation id, turn number, and a monotonic elapsed time, as an indented tree", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1000); // agent_start
    now.mockReturnValueOnce(1005); // turn_start
    now.mockReturnValueOnce(1010); // tool_execution_start
    now.mockReturnValueOnce(1040); // tool_execution_end
    now.mockReturnValueOnce(1041); // turn_end
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
    log({ type: "turn_end", message: { role: "assistant", content: [] } as never, toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "[conversation-a] t=+0.00ms turn=0 ▶ agent",
      "[conversation-a] t=+5.00ms turn=1   ▶ turn",
      '[conversation-a] t=+10.00ms turn=1     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "[conversation-a] t=+40.00ms turn=1     ◀ tool_end get_booking call=call-1 status=success",
      "[conversation-a] t=+41.00ms turn=1   ◀ turn_end tool_results=0",
      "[conversation-a] t=+42.00ms turn=1 ◀ agent_end",
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
      "[conversation-a] t=+0.00ms turn=0 ▶ agent",
      "[conversation-a] t=+50.00ms turn=1   ▶ turn",
    ]);
  });

  it("reads performance.now() once per event, not once per printed line", () => {
    // turn_end alone prints a [Timeline] header plus one detail line per tool call — if each
    // of those individually called elapsed(), this event would consume 3 clock reads instead
    // of 1, and every line would report a slightly different (and, under a mocked clock,
    // misaligned) elapsed time for what is really one instant.
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0); // agent_start
    now.mockReturnValueOnce(100); // turn_end

    const lines: string[] = [];
    const log = createResilienceTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "agent_start" });
    const turnEnd = {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "get_booking", arguments: {} }],
      },
      toolResults: [{ toolCallId: "call-1", toolName: "get_booking" }],
    } as unknown as AgentEvent;
    log(turnEnd);

    expect(now).toHaveBeenCalledTimes(2);
    const turnEndLines = lines.slice(1); // everything printed by the single turn_end call
    expect(turnEndLines.length).toBeGreaterThan(1); // a [Timeline] header plus at least one detail line
    expect(turnEndLines.every((line) => line.startsWith("[conversation-a] t=+100.00ms"))).toBe(true);
  });

  it("shows a parallel tool batch's toolCallId, source order, and transcript order together, as flat siblings", () => {
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
      '[conversation-a] t=+10.00ms turn=1     ▶ tool_start get_container_events call=call-a args={"containerNo":"MSKU1234567"}',
    );
    expect(lines).toContain(
      '[conversation-a] t=+15.00ms turn=1     ▶ tool_start get_port_status call=call-b args={"portCode":"CNSHA"}',
    );
    expect(lines).toContain(
      "[conversation-a] t=+121.00ms turn=1     [Timeline]   id=call-a get_container_events source=0 transcript=0 " +
        "start=+10.00ms end=+120.00ms duration=110.00ms",
    );
    expect(lines).toContain(
      "[conversation-a] t=+121.00ms turn=1     [Timeline]   id=call-b get_port_status source=1 transcript=1 " +
        "start=+15.00ms end=+60.00ms duration=45.00ms",
    );
  });
});
