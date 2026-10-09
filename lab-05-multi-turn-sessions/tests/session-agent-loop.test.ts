import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createSessionAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createSessionTraceLogger } from "../src/session-trace-logger.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(partial: Pick<AssistantMessage, "content" | "stopReason">): AssistantMessage {
  return { role: "assistant", api: "scripted", provider: "deepseek", model: "scripted", usage: USAGE, timestamp: 0, ...partial };
}

// One scripted stream shared by every agent in a test: it replays the next scripted assistant
// message per LLM call, in call order across all agents, and records the message roles each call
// received so the test can assert what each conversation's model call could see.
function scriptedStream(script: AssistantMessage[]): { streamFn: StreamFn; callRoles: string[][] } {
  const callRoles: string[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    callRoles.push((context as { messages: { role: string }[] }).messages.map((message) => message.role));
    const message = script[callRoles.length - 1];
    if (!message) throw new Error("scripted stream ran out of messages");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
    });
    return stream;
  };
  return { streamFn, callRoles };
}

const bookingToolCall = assistant({
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: "call-1", name: "get_booking", arguments: { bookingNo: "BK1001" } }],
});
const text = (value: string) => assistant({ stopReason: "stop", content: [{ type: "text", text: value }] });

describe("Lab 05 session registry against the pinned Pi release", () => {
  it("reuses one agent's transcript across prompts and isolates another conversation", async () => {
    const { streamFn, callRoles } = scriptedStream([
      bookingToolCall, // conversation-a, prompt 1, LLM call 1
      text("BK1001 details"), // conversation-a, prompt 1, LLM call 2
      text("MSKU1234567"), // conversation-a, prompt 2 (follow-up), LLM call 3
      text("Which booking do you mean?"), // conversation-b, prompt 1, LLM call 4
    ]);
    const selection = modelSelectionFromEnvironment({});
    const registry = createSessionRegistry(() => createSessionAgent(selection, streamFn));

    const a = registry.getOrCreate("conversation-a");
    await a.prompt("What are the details for booking BK1001?");
    await registry.getOrCreate("conversation-a").prompt("Which container is it using?");
    const b = registry.getOrCreate("conversation-b");
    await b.prompt("Which container is it using?");

    expect(registry.getOrCreate("conversation-a")).toBe(a);
    expect(b).not.toBe(a);

    // conversation-a's follow-up call carries the whole earlier transcript, including the tool result.
    expect(callRoles[2]).toEqual(["system", "user", "assistant", "toolResult", "assistant", "user"]);
    // conversation-b's first call carries only the leading system message and its own user message.
    expect(callRoles[3]).toEqual(["system", "user"]);

    expect(a.state.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(b.state.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("traces a reused agent as one tagged tree per prompt, with the turn counter continuing", async () => {
    const { streamFn } = scriptedStream([bookingToolCall, text("BK1001 details"), text("MSKU1234567")]);
    const registry = createSessionRegistry(() => createSessionAgent(modelSelectionFromEnvironment({}), streamFn));
    const lines: string[] = [];

    const agent = registry.getOrCreate("conversation-a");
    agent.subscribe(createSessionTraceLogger("conversation-a", (line) => lines.push(line)));
    await agent.prompt("What are the details for booking BK1001?");
    await registry.getOrCreate("conversation-a").prompt("Which container is it using?");

    expect(lines).toEqual([
      "[conversation-a] ▶ agent",
      "[conversation-a]   ▶ turn #1",
      '[conversation-a]     user       "What are the details for booking BK1001?"',
      '[conversation-a]     assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"}',
      '[conversation-a]     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "[conversation-a]     ◀ tool_end get_booking status=success",
      "[conversation-a]     toolResult get_booking status=success",
      "[conversation-a]   ◀ turn_end #1 tool_results=1",
      "[conversation-a]   ▶ turn #2",
      "[conversation-a]     [Assistant] BK1001 details",
      "[conversation-a]   ◀ turn_end #2 tool_results=0",
      "[conversation-a] ◀ agent_end",
      "[conversation-a] ▶ agent",
      "[conversation-a]   ▶ turn #3",
      '[conversation-a]     user       "Which container is it using?"',
      "[conversation-a]     [Assistant] MSKU1234567",
      "[conversation-a]   ◀ turn_end #3 tool_results=0",
      "[conversation-a] ◀ agent_end",
    ]);
  });

  it("starts a fresh transcript for the same conversation id after the registry is reset", async () => {
    const { streamFn, callRoles } = scriptedStream([text("first"), text("second")]);
    const registry = createSessionRegistry(() => createSessionAgent(modelSelectionFromEnvironment({}), streamFn));

    await registry.getOrCreate("conversation-a").prompt("first question");
    registry.reset();
    await registry.getOrCreate("conversation-a").prompt("follow-up");

    expect(callRoles[1]).toEqual(["system", "user"]);
  });
});
