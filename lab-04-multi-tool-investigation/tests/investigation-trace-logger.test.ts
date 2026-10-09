import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInvestigationTraceLogger } from "../src/investigation-trace-logger.js";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function toolCall(id: string, name: string, args: JsonObject): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "messages",
    provider: "deepseek",
    model: "deepseek-flash",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

describe("createInvestigationTraceLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the tool-call request on its own line even when the model also wrote text before it", () => {
    const lines: string[] = [];
    const log = createInvestigationTraceLogger((line) => lines.push(line));

    log({ type: "agent_start" });
    log({ type: "turn_start" });
    log({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "I'll look that up." },
        toolCall("call-1", "get_booking", { bookingNo: "BK1001" }),
      ]),
    });

    expect(lines.slice(2)).toEqual([
      "    [Assistant] I'll look that up.",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
    ]);
  });

  it("prints one line per tool call when the model requests several in one message", () => {
    const lines: string[] = [];
    const log = createInvestigationTraceLogger((line) => lines.push(line));

    log({
      type: "message_end",
      message: assistantMessage([
        toolCall("call-a", "get_container_events", { containerNo: "MSKU1234567" }),
        toolCall("call-b", "get_port_status", { portCode: "CNSHA" }),
      ]),
    });

    expect(lines).toEqual([
      'assistant (tool call) get_container_events call=call-a args={"containerNo":"MSKU1234567"}',
      'assistant (tool call) get_port_status call=call-b args={"portCode":"CNSHA"}',
    ]);
  });

  it("marks an assistant message with neither text nor tool calls as empty", () => {
    const lines: string[] = [];
    const log = createInvestigationTraceLogger((line) => lines.push(line));

    log({ type: "message_end", message: assistantMessage([]) });

    expect(lines).toEqual(["assistant (empty)"]);
  });

  it("renders the agent/turn/tool lifecycle as an indented tree", () => {
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
    log({ type: "turn_end", message: { role: "assistant", content: [] } as never, toolResults: [] });
    log({ type: "agent_end", messages: [] });

    expect(lines).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "  ◀ turn_end #1 tool_results=0",
      "◀ agent_end",
    ]);
  });

  it("orders a parallel tool batch by source position while exposing real completion timing, as flat siblings", () => {
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

    // get_port_status finishes first even though it started second — a genuine overlap, not
    // a nesting relationship, which is exactly why neither tool_start pushed its own span.
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
      "▶ agent",
      "  ▶ turn #1",
      '    ▶ tool_start get_container_events call=call-a args={"containerNo":"MSKU1234567"}',
      '    ▶ tool_start get_port_status call=call-b args={"portCode":"CNSHA"}',
      "    ◀ tool_end get_port_status status=success",
      "    ◀ tool_end get_container_events status=success",
      "    [Timeline] tool_calls=2",
      "    [Timeline]   get_container_events source=0 transcript=0 start=+10ms end=+120ms duration=110ms",
      "    [Timeline]   get_port_status source=1 transcript=1 start=+15ms end=+60ms duration=45ms",
      "  ◀ turn_end #1 tool_results=2",
    ]);
  });
});
