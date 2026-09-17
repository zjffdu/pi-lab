import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createTraceLogger } from "../src/trace-logger.js";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "messages",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
}

function assistantToolCallMessage(toolCallId: string, toolName: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    api: "messages",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function assistantErrorMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "messages",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

function toolResultMessage(toolName: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: "call-1", toolName, content: [], isError, timestamp: 0 };
}

describe("createTraceLogger", () => {
  it("renders a full agent/turn/tool/turn sequence as an indented, bracket-matched tree", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({ type: "message_end", message: userMessage("What are the details for booking BK1001?") });
    log({
      type: "message_end",
      message: assistantToolCallMessage("call-1", "get_booking", { bookingNo: "BK1001" }),
    });
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
    log({ type: "message_end", message: toolResultMessage("get_booking") });
    log({ type: "turn_end", message: assistantMessage(""), toolResults: [toolResultMessage("get_booking")] });
    log({ type: "turn_start" });
    log({ type: "message_end", message: assistantMessage("Booking BK1001 ships on the MAERSK TEST.") });
    log({ type: "turn_end", message: assistantMessage("Booking BK1001 ships on the MAERSK TEST."), toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      '    user       "What are the details for booking BK1001?"',
      "    assistant (tool calls: get_booking)",
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] Booking BK1001 ships on the MAERSK TEST.",
      "  ◀ turn_end #2 tool_results=0",
      "◀ agent_end",
    ]);
  });

  it("renders the provider's errorMessage instead of misreporting an empty assistant message as a tool call", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({ type: "message_end", message: userMessage("What are the details for booking BK1001?") });
    log({ type: "message_end", message: assistantErrorMessage("DEEPSEEK_API_KEY is invalid") });
    log({ type: "turn_end", message: assistantErrorMessage("DEEPSEEK_API_KEY is invalid"), toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      '    user       "What are the details for booking BK1001?"',
      "    assistant (error) DEEPSEEK_API_KEY is invalid",
      "  ◀ turn_end #1 tool_results=0",
      "◀ agent_end",
    ]);
  });

  it("emits no line for message_start, message_update, or tool_execution_update", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "message_start", message: userMessage("hi") });
    log({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "get_booking",
      args: {},
      partialResult: {},
    });

    expect(lines).toEqual([]);
  });

  it("does not let a tool_end with no matching tool_start reduce the enclosing turn's indent", () => {
    // This is the never-replay recovery shape from Lab 09: a closing event can arrive with
    // nothing matching on top of the span stack. Phase 1's plain Agent does not actually
    // produce this sequence itself, but the logger's close() guard is shared code and this
    // proves it degrades safely rather than corrupting every indent after it.
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "get_booking",
      result: {},
      isError: true,
    });
    log({ type: "turn_end", message: assistantMessage(""), toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      "    ◀ tool_end get_booking status=error",
      "  ◀ turn_end #1 tool_results=0",
      "◀ agent_end",
    ]);
  });
});
