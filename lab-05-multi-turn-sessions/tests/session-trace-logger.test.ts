import { describe, expect, it } from "vitest";

import { createSessionTraceLogger } from "../src/session-trace-logger.js";

describe("createSessionTraceLogger", () => {
  it("tags every line with the conversation id, and renders an indented agent/turn/tool tree", () => {
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
    log({ type: "turn_end", message: { role: "assistant", content: [] } as never, toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "[conversation-a] ▶ agent",
      "[conversation-a]   ▶ turn #1",
      '[conversation-a]     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "[conversation-a]     ◀ tool_end get_booking status=success",
      "[conversation-a]   ◀ turn_end #1 tool_results=0",
      "[conversation-a] ◀ agent_end",
    ]);
  });

  it("keeps counting turns across multiple prompts on the same logger, evidence of session reuse", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "turn_start" });
    log({ type: "turn_end", message: { role: "assistant", content: [] } as never, toolResults: [] });
    log({ type: "turn_start" });

    expect(lines).toEqual([
      "[conversation-a] ▶ turn #1",
      "[conversation-a] ◀ turn_end #1 tool_results=0",
      "[conversation-a] ▶ turn #2",
    ]);
  });

  it("keeps two different conversation ids' tags distinct even though each logger's own tree is independent", () => {
    const linesA: string[] = [];
    const linesB: string[] = [];
    const logA = createSessionTraceLogger("conversation-a", (line) => linesA.push(line));
    const logB = createSessionTraceLogger("conversation-b", (line) => linesB.push(line));

    logA({ type: "agent_start" });
    logB({ type: "agent_start" });
    logA({ type: "agent_end", messages: [] });
    logB({ type: "agent_end", messages: [] });

    expect(linesA).toEqual(["[conversation-a] ▶ agent", "[conversation-a] ◀ agent_end"]);
    expect(linesB).toEqual(["[conversation-b] ▶ agent", "[conversation-b] ◀ agent_end"]);
  });
});
