import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createInvestigationAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { createInvestigationTraceLogger } from "../src/investigation-trace-logger.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  partial: Pick<AssistantMessage, "content" | "stopReason"> & { errorMessage?: string },
): AssistantMessage {
  return {
    role: "assistant",
    api: "scripted",
    provider: "deepseek",
    model: "scripted",
    usage: USAGE,
    timestamp: 0,
    ...partial,
  };
}

function toolCall(id: string, name: string, args: JsonObject): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

// Replays scripted assistant messages, one per LLM call, through the real Agent loop.
function scriptedStream(script: AssistantMessage[]): { streamFn: StreamFn; contexts: unknown[] } {
  const contexts: unknown[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    const message = script[contexts.length - 1];
    if (!message) throw new Error("scripted stream ran out of messages");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
    });
    return stream;
  };
  return { streamFn, contexts };
}

// Turn 1 resolves the booking; turn 2 requests get_port_status FIRST and get_container_events
// SECOND in one assistant message; turn 3 answers. Combined with a delayed get_port_status, this
// makes source order (port, events) and completion order (events, port) deliberately disagree.
function investigationScript(portCode = "CNSHA"): AssistantMessage[] {
  return [
    assistant({
      stopReason: "toolUse",
      content: [toolCall("call-booking", "get_booking", { bookingNo: "BK1001" })],
    }),
    assistant({
      stopReason: "toolUse",
      content: [
        toolCall("call-port", "get_port_status", { portCode }),
        toolCall("call-events", "get_container_events", { containerNo: "MSKU1234567" }),
      ],
    }),
    assistant({ stopReason: "stop", content: [{ type: "text", text: "final answer" }] }),
  ];
}

const DELAYED_PORT_STATUS = { LAB04_PORT_STATUS_DELAY_MS: "50" } as NodeJS.ProcessEnv;

function scrubTiming(line: string): string {
  return line.replace(/\+\d+ms/g, "+Nms").replace(/duration=\d+ms/g, "duration=Nms");
}

describe("Lab 04 multi-tool loop against the pinned Pi release", () => {
  it("runs the dependent booking -> parallel evidence -> answer chain and traces it as a tree", async () => {
    const { streamFn } = scriptedStream(investigationScript());
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), DELAYED_PORT_STATUS, streamFn);
    const lines: string[] = [];
    agent.subscribe(createInvestigationTraceLogger((line) => lines.push(line)));

    await agent.prompt("Investigate booking BK1001");

    expect(lines.map(scrubTiming)).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      '    user       "Investigate booking BK1001"',
      '    assistant (tool call) get_booking call=call-booking args={"bookingNo":"BK1001"}',
      '    ▶ tool_start get_booking call=call-booking args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success",
      "    [Timeline] tool_calls=1",
      "    [Timeline]   get_booking source=0 transcript=0 start=+Nms end=+Nms duration=Nms",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      '    assistant (tool call) get_port_status call=call-port args={"portCode":"CNSHA"}',
      '    assistant (tool call) get_container_events call=call-events args={"containerNo":"MSKU1234567"}',
      '    ▶ tool_start get_port_status call=call-port args={"portCode":"CNSHA"}',
      '    ▶ tool_start get_container_events call=call-events args={"containerNo":"MSKU1234567"}',
      "    ◀ tool_end get_container_events status=success",
      "    ◀ tool_end get_port_status status=success",
      "    toolResult get_port_status status=success",
      "    toolResult get_container_events status=success",
      "    [Timeline] tool_calls=2",
      "    [Timeline]   get_port_status source=0 transcript=0 start=+Nms end=+Nms duration=Nms",
      "    [Timeline]   get_container_events source=1 transcript=1 start=+Nms end=+Nms duration=Nms",
      "  ◀ turn_end #2 tool_results=2",
      "  ▶ turn #3",
      "    [Assistant] final answer",
      "  ◀ turn_end #3 tool_results=0",
      "◀ agent_end",
    ]);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("emits tool_execution_end in completion order but keeps tool results in assistant source order", async () => {
    const { streamFn } = scriptedStream(investigationScript());
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), DELAYED_PORT_STATUS, streamFn);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("Investigate booking BK1001");

    const executionEnds = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolName] : []));
    expect(executionEnds).toEqual(["get_booking", "get_container_events", "get_port_status"]);

    const turnEnds = events.flatMap((event) => (event.type === "turn_end" ? [event] : []));
    expect(turnEnds[1]?.toolResults.map((result) => result.toolName)).toEqual([
      "get_port_status",
      "get_container_events",
    ]);

    const toolResultsInTranscript = agent.state.messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolName] : [],
    );
    expect(toolResultsInTranscript).toEqual(["get_booking", "get_port_status", "get_container_events"]);
  });

  it("reports real timing so the delayed tool visibly ends later without changing transcript order", async () => {
    const { streamFn } = scriptedStream(investigationScript());
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), DELAYED_PORT_STATUS, streamFn);
    const lines: string[] = [];
    agent.subscribe(createInvestigationTraceLogger((line) => lines.push(line)));

    await agent.prompt("Investigate booking BK1001");

    const endOf = (toolName: string): number => {
      const line = lines.find((candidate) => candidate.includes(`[Timeline]   ${toolName} source=`));
      const match = line?.match(/end=\+(\d+)ms/);
      if (!match?.[1]) throw new Error(`no timeline line for ${toolName}`);
      return Number(match[1]);
    };

    expect(endOf("get_port_status") - endOf("get_container_events")).toBeGreaterThanOrEqual(30);
    expect(lines.some((line) => line.includes("get_port_status source=0 transcript=0"))).toBe(true);
    expect(lines.some((line) => line.includes("get_container_events source=1 transcript=1"))).toBe(true);
  });

  // Pi 1.x carries the system prompt as a leading system message in the transcript. It is part of
  // agent.state.messages and of what the model receives, but it emits no message_* event, so it
  // never appears in the trace tree. The third LLM call also proves the full history is resent.
  it("starts the transcript with the system prompt and resends the full history on every call", async () => {
    const { streamFn, contexts } = scriptedStream(investigationScript());
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), DELAYED_PORT_STATUS, streamFn);

    await agent.prompt("Investigate booking BK1001");

    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    const roles = (index: number): string[] =>
      (contexts[index] as { messages: { role: string }[] }).messages.map((message) => message.role);
    expect(roles(0)).toEqual(["system", "user"]);
    expect(roles(1)).toEqual(["system", "user", "assistant", "toolResult"]);
    expect(roles(2)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
  });

  it("turns an unknown booking into a tool error that is fed to the next turn", async () => {
    const { streamFn } = scriptedStream([
      assistant({
        stopReason: "toolUse",
        content: [toolCall("call-booking", "get_booking", { bookingNo: "BAD_ID" })],
      }),
      assistant({ stopReason: "stop", content: [{ type: "text", text: "booking not found" }] }),
    ]);
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), {}, streamFn);
    const lines: string[] = [];
    agent.subscribe(createInvestigationTraceLogger((line) => lines.push(line)));

    await agent.prompt("Investigate booking BAD_ID");

    expect(lines).toContain("    ◀ tool_end get_booking status=error");
    expect(lines).toContain("    toolResult get_booking status=error");
    expect(lines).toContain("  ▶ turn #2");
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("keeps a successful sibling result when one tool in a parallel batch fails on missing port status", async () => {
    const { streamFn } = scriptedStream(investigationScript("ZZZZZ"));
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), {}, streamFn);
    const lines: string[] = [];
    agent.subscribe(createInvestigationTraceLogger((line) => lines.push(line)));

    await agent.prompt("Investigate booking BK1001");

    expect(lines).toContain("    ◀ tool_end get_port_status status=error");
    expect(lines).toContain("    ◀ tool_end get_container_events status=success");
    expect(lines).toContain("    toolResult get_port_status status=error");
    expect(lines).toContain("    toolResult get_container_events status=success");
    expect(lines).toContain("  ▶ turn #3");
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("records a provider failure in agent.state.errorMessage so the CLI can exit non-zero", async () => {
    const { streamFn } = scriptedStream([
      assistant({ stopReason: "error", errorMessage: "401 invalid api key", content: [] }),
    ]);
    const agent = createInvestigationAgent(modelSelectionFromEnvironment({}), {}, streamFn);
    const lines: string[] = [];
    agent.subscribe(createInvestigationTraceLogger((line) => lines.push(line)));

    await agent.prompt("Investigate booking BK1001");

    expect(agent.state.errorMessage).toBe("401 invalid api key");
    expect(lines).toContain("    assistant (error) 401 invalid api key");
  });
});
