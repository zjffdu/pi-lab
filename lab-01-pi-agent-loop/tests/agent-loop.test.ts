import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createBookingAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { createTraceLogger } from "../src/trace-logger.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(partial: Pick<AssistantMessage, "content" | "stopReason"> & { errorMessage?: string }): AssistantMessage {
  return { role: "assistant", api: "scripted", provider: "deepseek", model: "scripted", usage: USAGE, timestamp: 0, ...partial };
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

function toolCallThenAnswer(bookingNo: string): AssistantMessage[] {
  return [
    assistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "get_booking", arguments: { bookingNo } }],
    }),
    assistant({ stopReason: "stop", content: [{ type: "text", text: "final answer" }] }),
  ];
}

describe("Lab 01 agent loop against the pinned Pi release", () => {
  it("runs prompt -> tool call -> tool result -> second turn and traces it as a tree", async () => {
    const { streamFn } = scriptedStream(toolCallThenAnswer("BK1001"));
    const agent = createBookingAgent(modelSelectionFromEnvironment({}), streamFn);
    const lines: string[] = [];
    agent.subscribe(createTraceLogger((line) => lines.push(line)));

    await agent.prompt("What are the details for booking BK1001?");

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
      "    [Assistant] final answer",
      "  ◀ turn_end #2 tool_results=0",
      "◀ agent_end",
    ]);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  // Pi 1.x carries the system prompt as a leading system message in the transcript. It is part of
  // agent.state.messages and of what the model receives, but it emits no message_* event, so it
  // never appears in the trace tree.
  it("starts the transcript with the system prompt as a system message", async () => {
    const { streamFn, contexts } = scriptedStream(toolCallThenAnswer("BK1001"));
    const agent = createBookingAgent(modelSelectionFromEnvironment({}), streamFn);

    await agent.prompt("What are the details for booking BK1001?");

    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const secondCall = contexts[1] as { messages: { role: string }[] };
    expect(secondCall.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);
  });

  it("turns an unknown booking into a tool error that is fed to the next turn", async () => {
    const { streamFn } = scriptedStream(toolCallThenAnswer("BAD_ID"));
    const agent = createBookingAgent(modelSelectionFromEnvironment({}), streamFn);
    const lines: string[] = [];
    agent.subscribe(createTraceLogger((line) => lines.push(line)));

    await agent.prompt("What are the details for booking BAD_ID?");

    expect(lines).toContain("    ◀ tool_end get_booking status=error");
    expect(lines).toContain("    toolResult get_booking status=error");
    expect(lines).toContain("  ▶ turn #2");
  });

  it("records a provider failure in agent.state.errorMessage so the CLI can exit non-zero", async () => {
    const { streamFn } = scriptedStream([
      assistant({ stopReason: "error", errorMessage: "401 invalid api key", content: [] }),
    ]);
    const agent = createBookingAgent(modelSelectionFromEnvironment({}), streamFn);
    const lines: string[] = [];
    agent.subscribe(createTraceLogger((line) => lines.push(line)));

    await agent.prompt("What are the details for booking BK1001?");

    expect(agent.state.errorMessage).toBe("401 invalid api key");
    expect(lines).toContain("    assistant (error) 401 invalid api key");
  });
});
