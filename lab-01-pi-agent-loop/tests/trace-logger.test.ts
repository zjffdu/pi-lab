import type { AssistantMessage, JsonObject, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
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
    model: "deepseek-flash",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
}

function assistantToolCallMessage(
  toolCallId: string,
  toolName: string,
  args: JsonObject,
  text = "",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      { type: "toolCall", id: toolCallId, name: toolName, arguments: args },
    ],
    api: "messages",
    provider: "deepseek",
    model: "deepseek-flash",
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
    model: "deepseek-flash",
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
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
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

  it("shows the tool-call request on its own line even when the model also wrote text before it", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({
      type: "message_end",
      message: assistantToolCallMessage("call-1", "get_booking", { bookingNo: "BK1001" }, "I'll look that up."),
    });

    expect(lines.slice(2)).toEqual([
      "    [Assistant] I'll look that up.",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
    ]);
  });

  it("prints one line per tool call when the model requests several in one message", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));
    const message = assistantToolCallMessage("call-1", "get_booking", { bookingNo: "BK1001" });
    message.content.push({ type: "toolCall", id: "call-2", name: "get_booking", arguments: { bookingNo: "BK1002" } });

    log({ type: "message_end", message });

    expect(lines).toEqual([
      'assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
      'assistant (tool call) get_booking call=call-2 args={"bookingNo":"BK1002"}',
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
    // Tool lines never push/pop a span of their own (see the file-level comment in
    // trace-logger.ts) — this proves a lone, unmatched tool_execution_end still prints as a
    // plain child of the open turn instead of corrupting the turn's own closing indent.
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

  it("renders two overlapping tool calls as flat siblings instead of nesting one inside the other", () => {
    // Lab 04 and Lab 06 both exercise real parallel tool execution: the model can request
    // two tool calls in one turn, and their execution windows can genuinely overlap
    // (start A, start B, end A, end B). If "tool" were its own push/pop span, this exact
    // interleaving would pop the wrong stack entry on `end A` and throw off every indent
    // after it. Printing every tool line at the turn's own child depth sidesteps that: the
    // four lines stay flat and in event order, and each remains self-identifying by its own
    // toolCallId/toolName — exactly how a reader would disambiguate them today regardless of
    // indentation.
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({ type: "tool_execution_start", toolCallId: "call-a", toolName: "get_container_events", args: {} });
    log({ type: "tool_execution_start", toolCallId: "call-b", toolName: "get_port_status", args: {} });
    log({ type: "tool_execution_end", toolCallId: "call-a", toolName: "get_container_events", result: {}, isError: false });
    log({ type: "tool_execution_end", toolCallId: "call-b", toolName: "get_port_status", result: {}, isError: false });
    log({ type: "turn_end", message: assistantMessage(""), toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      "    ▶ tool_start get_container_events call=call-a args={}",
      "    ▶ tool_start get_port_status call=call-b args={}",
      "    ◀ tool_end get_container_events status=success",
      "    ◀ tool_end get_port_status status=success",
      "  ◀ turn_end #1 tool_results=0",
      "◀ agent_end",
    ]);
  });
});
