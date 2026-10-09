import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createSessionTraceLogger } from "../src/session-trace-logger.js";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "messages",
    provider: "deepseek",
    model: "deepseek-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

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

  it("shows the tool-call request on its own line even when the model also wrote text before it", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

    log({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "I'll look that up." },
        { type: "toolCall", id: "call-1", name: "get_booking", arguments: { bookingNo: "BK1001" } },
      ]),
    });

    expect(lines).toEqual([
      "[conversation-a] [Assistant] I'll look that up.",
      '[conversation-a] assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
    ]);
  });

  it("prints one line per tool call when the model requests several in one message", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

    log({
      type: "message_end",
      message: assistantMessage([
        { type: "toolCall", id: "call-1", name: "get_booking", arguments: { bookingNo: "BK1001" } },
        { type: "toolCall", id: "call-2", name: "get_booking", arguments: { bookingNo: "BK1002" } },
      ]),
    });

    expect(lines).toEqual([
      '[conversation-a] assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
      '[conversation-a] assistant (tool call) get_booking call=call-2 args={"bookingNo":"BK1002"}',
    ]);
  });

  it("renders the provider's errorMessage instead of misreporting an empty assistant message as a tool call", () => {
    const lines: string[] = [];
    const log = createSessionTraceLogger("conversation-a", (line) => lines.push(line));

    log({ type: "message_end", message: { ...assistantMessage([]), stopReason: "error", errorMessage: "401 invalid api key" } });

    expect(lines).toEqual(["[conversation-a] assistant (error) 401 invalid api key"]);
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
