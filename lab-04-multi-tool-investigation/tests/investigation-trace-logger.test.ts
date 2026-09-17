import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInvestigationTraceLogger } from "../src/investigation-trace-logger.js";

describe("createInvestigationTraceLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes the agent, turn, and tool lifecycle visible", () => {
    const lines: string[] = [];
    const log = createInvestigationTraceLogger((line) => lines.push(line));

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
      "[Pi] agent_start",
      "[Pi] turn_start #1",
      '[Tool] start get_booking args={"bookingNo":"BK1001"}',
      "[Tool] end get_booking status=success",
      "[Pi] agent_end",
    ]);
  });

  it("orders a parallel tool batch by source position while exposing real completion timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const lines: string[] = [];
    const log = createInvestigationTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });

    vi.setSystemTime(10);
    log({
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "get_container_events",
      args: { containerNo: "MSKU1234567" },
    });

    vi.setSystemTime(15);
    log({
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "get_port_status",
      args: { portCode: "CNSHA" },
    });

    // get_port_status finishes first even though it started second.
    vi.setSystemTime(60);
    log({
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "get_port_status",
      result: {},
      isError: false,
    });

    vi.setSystemTime(120);
    log({
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "get_container_events",
      result: {},
      isError: false,
    });

    // Pi reassembles tool-result messages in assistant source order, regardless
    // of completion order, so transcript order mirrors source order here.
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

    expect(lines).toEqual([
      "[Pi] agent_start",
      "[Pi] turn_start #1",
      '[Tool] start get_container_events args={"containerNo":"MSKU1234567"}',
      '[Tool] start get_port_status args={"portCode":"CNSHA"}',
      "[Tool] end get_port_status status=success",
      "[Tool] end get_container_events status=success",
      "[Timeline] turn #1 tool_calls=2",
      "[Timeline]   get_container_events source=0 transcript=0 start=+10ms end=+120ms duration=110ms",
      "[Timeline]   get_port_status source=1 transcript=1 start=+15ms end=+60ms duration=45ms",
      "[Pi] turn_end #1 tool_results=2",
    ]);
  });
});
