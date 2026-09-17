import { describe, expect, it } from "vitest";

import { createSessionTraceLogger } from "../src/session-trace-logger.js";

describe("createSessionTraceLogger", () => {
  it("tags every line with the conversation id", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

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
      "[Pi][conversation-a] agent_start",
      "[Pi][conversation-a] turn_start #1",
      '[Tool][conversation-a] start get_booking args={"bookingNo":"BK1001"}',
      "[Tool][conversation-a] end get_booking status=success",
      "[Pi][conversation-a] agent_end",
    ]);
  });

  it("keeps counting turns across multiple prompts on the same logger, evidence of session reuse", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "turn_start" });
    log({ type: "turn_start" });

    expect(lines).toEqual([
      "[Pi][conversation-a] turn_start #1",
      "[Pi][conversation-a] turn_start #2",
    ]);
  });
});
