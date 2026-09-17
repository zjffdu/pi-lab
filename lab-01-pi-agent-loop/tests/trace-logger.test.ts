import { describe, expect, it } from "vitest";

import { createTraceLogger } from "../src/trace-logger.js";

describe("createTraceLogger", () => {
  it("makes the agent, turn, and tool lifecycle visible", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

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
});
