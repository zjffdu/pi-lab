import type { Agent, AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createConcurrentMessagePolicy } from "../src/concurrent-message-policy.js";
import { createResilienceAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createResilienceTraceLogger } from "../src/trace-logger.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(partial: Pick<AssistantMessage, "content" | "stopReason">): AssistantMessage {
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

const text = (value: string) => assistant({ stopReason: "stop", content: [{ type: "text", text: value }] });

// Replays scripted assistant messages, one per LLM call, through the real Agent loop. A call beyond
// the end of the script throws, so a test that expects exactly N provider requests fails loudly if
// the loop makes N+1.
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

// Turn 1 resolves the booking (BK1001 has two containers); turn 2 requests get_port_status FIRST and
// then get_container_events once per container, all in one assistant message. With get_port_status
// delayed, source order (port, events, events-2) and completion order (events, events-2, port)
// deliberately disagree.
const bookingThenBatch = (bookingNo = "BK1001"): AssistantMessage[] => [
  assistant({ stopReason: "toolUse", content: [toolCall("call-booking", "get_booking", { bookingNo })] }),
  assistant({
    stopReason: "toolUse",
    content: [
      toolCall("call-port", "get_port_status", { portCode: "CNSHA" }),
      toolCall("call-events", "get_container_events", { containerNo: "MSKU1234567" }),
      toolCall("call-events-2", "get_container_events", { containerNo: "MSKU2345678" }),
    ],
  }),
];

const SLOW_PORT = { portStatusDelayMs: 50 };

function createAgent(script: AssistantMessage[], options = SLOW_PORT): { agent: Agent; callRoles: string[][] } {
  const { streamFn, callRoles } = scriptedStream(script);
  return { agent: createResilienceAgent(modelSelectionFromEnvironment({}), options, streamFn), callRoles };
}

function record(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return events;
}

const roles = (agent: Agent): string[] => agent.state.messages.map((message) => message.role);

function toolResultIds(agent: Agent): string[] {
  return agent.state.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
}

function scrub(line: string): string {
  return line
    .replace(/t=\s*\+\d+\.\d+ms/, "t=T")
    .replace(/(start|end)=\+\d+\.\d+ms/g, "$1=+N")
    .replace(/duration=\d+\.\d+ms/, "duration=N");
}

describe("Experiment A — tool error, against the pinned Pi release", () => {
  it("turns BAD_ID into exactly one error tool result, then runs a second turn that can answer", async () => {
    const { agent } = createAgent(
      [
        assistant({
          stopReason: "toolUse",
          content: [toolCall("call-booking", "get_booking", { bookingNo: "BAD_ID" })],
        }),
        text("booking not found"),
      ],
      { portStatusDelayMs: 0 },
    );
    const lines: string[] = [];
    agent.subscribe(createResilienceTraceLogger("experiment-a", (line) => lines.push(scrub(line))));

    await agent.prompt("Look up booking BAD_ID");

    expect(lines).toContain(
      '[experiment-a] t=T turn=1     assistant (tool call) get_booking call=call-booking args={"bookingNo":"BAD_ID"}',
    );
    expect(lines).toContain("[experiment-a] t=T turn=1     ◀ tool_end get_booking call=call-booking status=error");
    expect(lines).toContain("[experiment-a] t=T turn=1     toolResult get_booking status=error");
    expect(lines).toContain("[experiment-a] t=T turn=2     [Assistant] booking not found");
    expect(toolResultIds(agent)).toEqual(["call-booking"]);
    expect(roles(agent)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
    expect(agent.state.errorMessage).toBeUndefined();
  });
});

describe("Experiment B — steer() while a slow tool is running", () => {
  it("injects the steering message only after the whole tool batch and turn_end, in the next turn", async () => {
    const { agent, callRoles } = createAgent([...bookingThenBatch(), text("answer that folds in the steer")]);
    const events = record(agent);
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "get_port_status") {
        agent.steer({ role: "user", content: "also: will it get worse?", timestamp: Date.now() });
      }
    });

    await agent.prompt("Investigate booking BK1001");

    const indexOf = (predicate: (event: AgentEvent) => boolean): number => events.findIndex(predicate);
    const portEnd = indexOf((e) => e.type === "tool_execution_end" && e.toolName === "get_port_status");
    const batchTurnEnd = indexOf((e) => e.type === "turn_end" && e.toolResults.length === 3);
    const steerMessage = indexOf(
      (e) => e.type === "message_end" && e.message.role === "user" && e.message.content === "also: will it get worse?",
    );
    const thirdTurnStart = events.findIndex((e, i) => e.type === "turn_start" && i > batchTurnEnd);

    expect(portEnd).toBeGreaterThan(-1);
    expect(batchTurnEnd).toBeGreaterThan(portEnd);
    expect(thirdTurnStart).toBeGreaterThan(batchTurnEnd);
    expect(steerMessage).toBeGreaterThan(thirdTurnStart);

    // Three provider requests, and the third one is the first to see the steering message.
    expect(callRoles).toHaveLength(3);
    expect(callRoles[1]).toEqual(["system", "user", "assistant", "toolResult"]);
    expect(callRoles[2]).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(roles(agent)).toEqual([...callRoles[2]!, "assistant"]);
  });
});

describe("Experiment C — followUp() while a slow tool is running", () => {
  it("waits until the agent would otherwise stop, costing one extra turn after the ordinary final answer", async () => {
    const { agent, callRoles } = createAgent([
      ...bookingThenBatch(),
      text("ordinary final answer"),
      text("one-sentence dashboard summary"),
    ]);
    const events = record(agent);
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "get_port_status") {
        agent.followUp({ role: "user", content: "also: dashboard summary", timestamp: Date.now() });
      }
    });

    await agent.prompt("Investigate booking BK1001");

    // Four provider requests: the ordinary run's three, plus one for the queued follow-up.
    expect(callRoles).toHaveLength(4);
    // The third request (the ordinary final answer) has NOT seen the follow-up yet ...
    expect(callRoles[2]).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);
    // ... only the fourth does, after the ordinary final answer is already in the transcript.
    expect(callRoles[3]).toEqual([...callRoles[2]!, "assistant", "user"]);
    expect(roles(agent)).toEqual([...callRoles[3]!, "assistant"]);

    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(4);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });
});

describe("Experiment D — parallel tools, completion order versus transcript order", () => {
  it("emits tool_execution_end in completion order but keeps tool results in assistant source order", async () => {
    const { agent } = createAgent([...bookingThenBatch(), text("final answer")]);
    const events = record(agent);

    await agent.prompt("Investigate booking BK1001");

    const starts = events.flatMap((event) => (event.type === "tool_execution_start" ? [event.toolName] : []));
    const ends = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolName] : []));
    expect(starts).toEqual(["get_booking", "get_port_status", "get_container_events", "get_container_events"]);
    expect(ends).toEqual(["get_booking", "get_container_events", "get_container_events", "get_port_status"]);

    const turnEnds = events.flatMap((event) => (event.type === "turn_end" ? [event] : []));
    expect(turnEnds[1]?.toolResults.map((result) => result.toolCallId)).toEqual([
      "call-port",
      "call-events",
      "call-events-2",
    ]);

    // Exactly one persisted tool result per tool call, in source order.
    expect(toolResultIds(agent)).toEqual(["call-booking", "call-port", "call-events", "call-events-2"]);
  });

  it("reports the delayed tool ending later in the Timeline without changing source or transcript order", async () => {
    const { agent } = createAgent([...bookingThenBatch(), text("final answer")]);
    const lines: string[] = [];
    agent.subscribe(createResilienceTraceLogger("experiment-d", (line) => lines.push(line)));

    await agent.prompt("Investigate booking BK1001");

    // Look up by toolCallId: the two get_container_events calls share a tool name.
    const timeline = (callId: string): string => {
      const line = lines.find((candidate) => candidate.includes(`[Timeline]   id=${callId} `));
      if (!line) throw new Error(`no timeline line for ${callId}`);
      return line;
    };
    const endOf = (callId: string): number => Number(timeline(callId).match(/ end=\+(\d+\.\d+)ms/)?.[1]);

    expect(timeline("call-port")).toContain("source=0 transcript=0");
    expect(timeline("call-events")).toContain("source=1 transcript=1");
    expect(timeline("call-events-2")).toContain("source=2 transcript=2");
    expect(endOf("call-port") - endOf("call-events")).toBeGreaterThanOrEqual(30);
    expect(endOf("call-port") - endOf("call-events-2")).toBeGreaterThanOrEqual(30);
  });

  it("prints each requested call as its own assistant line, ahead of the tool_start lines that execute them", async () => {
    const { agent } = createAgent([...bookingThenBatch(), text("final answer")]);
    const lines: string[] = [];
    agent.subscribe(createResilienceTraceLogger("experiment-d", (line) => lines.push(scrub(line))));

    await agent.prompt("Investigate booking BK1001");

    const turn2 = lines.filter((line) => line.includes("turn=2") && /assistant \(tool call\)|tool_start/.test(line));
    expect(turn2).toEqual([
      '[experiment-d] t=T turn=2     assistant (tool call) get_port_status call=call-port args={"portCode":"CNSHA"}',
      '[experiment-d] t=T turn=2     assistant (tool call) get_container_events call=call-events args={"containerNo":"MSKU1234567"}',
      '[experiment-d] t=T turn=2     assistant (tool call) get_container_events call=call-events-2 args={"containerNo":"MSKU2345678"}',
      '[experiment-d] t=T turn=2     ▶ tool_start get_port_status call=call-port args={"portCode":"CNSHA"}',
      '[experiment-d] t=T turn=2     ▶ tool_start get_container_events call=call-events args={"containerNo":"MSKU1234567"}',
      '[experiment-d] t=T turn=2     ▶ tool_start get_container_events call=call-events-2 args={"containerNo":"MSKU2345678"}',
    ]);
  });
});

describe("Concurrency policy against the real Agent", () => {
  // The unit test for the policy uses a fake agent that flips isStreaming synchronously inside
  // prompt(). This proves the real Agent does the same: a second sendMessage in the SAME tick must
  // see isStreaming === true instead of starting a second, concurrent prompt().
  it("queues a same-tick second message as a follow-up instead of starting a second prompt()", async () => {
    const { streamFn, callRoles } = scriptedStream([text("answer one"), text("answer two")]);
    const registry = createSessionRegistry(() =>
      createResilienceAgent(modelSelectionFromEnvironment({}), { portStatusDelayMs: 0 }, streamFn),
    );
    const policy = createConcurrentMessagePolicy(registry);

    const first = policy.sendMessage("conversation-a", "first message");
    const second = policy.sendMessage("conversation-a", "second message");

    expect(first.delivery).toBe("prompted");
    expect(second.delivery).toBe("queued-as-follow-up");
    expect(second.settled).toBe(first.settled);

    await Promise.all([first.settled, second.settled]);

    const agent = registry.getOrCreate("conversation-a");
    expect(callRoles).toEqual([
      ["system", "user"],
      ["system", "user", "assistant", "user"],
    ]);
    expect(roles(agent)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("starts a fresh prompt() once the conversation has gone idle again", async () => {
    const { streamFn } = scriptedStream([text("answer one"), text("answer two")]);
    const registry = createSessionRegistry(() =>
      createResilienceAgent(modelSelectionFromEnvironment({}), { portStatusDelayMs: 0 }, streamFn),
    );
    const policy = createConcurrentMessagePolicy(registry);

    await policy.sendMessage("conversation-a", "first message").settled;
    const second = policy.sendMessage("conversation-a", "second message");
    await second.settled;

    expect(second.delivery).toBe("prompted");
    expect(roles(registry.getOrCreate("conversation-a"))).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
