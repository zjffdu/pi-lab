import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";

import { createTelemetryBridge } from "../src/harness-telemetry.js";
import { findByName } from "../src/span-tree.js";

/**
 * Event-level proof of the bridge, fed hand-built `AgentEvent` batches. These cover what a real run cannot be
 * made to produce on demand — a retry, a compaction, a faulted tool, an overflowed stream — while
 * `evaluation-runner.test.ts` proves the same bridge against the real `Harness` event stream. The batch shape
 * is exactly `watchEvents`' (`events.d.ts`): ids are branded numbers, entries carry `model` messages.
 */

const TOOL_REPLAY = new Map([
  ["get_booking", "safe" as const],
  ["update_booking_status", "unsafe" as const],
]);

function bridge() {
  const telemetry = new InMemoryTelemetryContext();
  const built = createTelemetryBridge({ telemetry, conversationId: "1", toolReplayByName: TOOL_REPLAY });
  return { telemetry, ...built };
}

/**
 * `closeSpan` resolves the pending span's promise synchronously, but `settleSpan` only runs in the `.then()`
 * continuation of that promise (`pi-telemetry/dist/memory.js:116-122`) — one microtask later. `setAttributes`
 * and `setStatus` made before the resolve are visible at once; `settled`/`endSequence` are not until this flush.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const id = (value: number) => value as never;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-flash",
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

function entry(entryId: number, message: AssistantMessage | ToolResultMessage): EntryRecord {
  return { id: id(entryId), conversationId: id(1), kind: "pi.assistant", model: [message] } as EntryRecord;
}

const toolResult = (isError = false): ToolResultMessage =>
  ({ role: "toolResult", toolCallId: "call-1", toolName: "get_booking", content: [], isError, timestamp: 0 }) as ToolResultMessage;

const runStart: AgentEvent = { type: "run_start", inputs: [id(8)] };
const runEnd: AgentEvent = { type: "run_end", inputs: [id(8)] };
const turnStart: AgentEvent = { type: "turn_start" };
const turnEnd: AgentEvent = { type: "turn_end" };
const toolStart: AgentEvent = { type: "tool_execution_start", toolCallId: "call-1", toolName: "get_booking", args: { bookingNo: "BK1001" } };

describe("createTelemetryBridge", () => {
  it("nests turn under run, and request/tool/retry under their turn", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "message_end", entry: entry(11, assistant({ stopReason: "toolUse" })) },
      toolStart,
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "get_booking", entry: entry(13, toolResult()) },
      { type: "message_end", entry: entry(13, toolResult()) },
      turnEnd,
      runEnd,
    ]);
    await flush();

    const spans = target.telemetry.getSpans();
    const run = findByName(spans, "lab.run")[0]!;
    const turn = findByName(spans, "lab.turn")[0]!;
    const request = findByName(spans, "lab.ai.request")[0]!;
    const tool = findByName(spans, "lab.tool")[0]!;

    expect(run.parentId).toBeNull();
    expect(turn.parentId).toBe(run.id);
    expect(request.parentId).toBe(turn.id);
    expect(tool.parentId).toBe(turn.id);
    expect(spans.every((span) => span.settled)).toBe(true);
    expect(run.attributes).toMatchObject({ "lab.conversation.id": "1", "lab.run.input_count": 1 });
    expect(turn.attributes).toMatchObject({ "lab.turn.number": 1, "lab.turn.tool_result_count": 1 });
    expect(tool.attributes).toMatchObject({
      "lab.tool.name": "get_booking",
      "lab.tool.call_id": "call-1",
      "lab.tool.replay": "safe",
      "lab.tool.outcome": "result",
      "lab.tool.is_error": false,
    });
    expect(tool.status).toEqual({ status: "ok" });
    expect(target.warnings).toEqual([]);
  });

  it("fills a lab.ai.request span from the committed assistant message alone — usage, stop reason, duration", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "message_end", entry: entry(11, assistant({ durationMs: 321.6, responseId: "resp-1", responseModel: "deepseek-flash-0905" })) },
    ]);
    await flush();

    const request = findByName(target.telemetry.getSpans(), "lab.ai.request")[0]!;
    expect(request.attributes).toMatchObject({
      "lab.ai.provider": "deepseek",
      "lab.ai.model": "deepseek-flash",
      "lab.ai.api": "openai-completions",
      "lab.ai.stop_reason": "stop",
      "lab.ai.duration_ms": 321.6,
      "lab.ai.response_id": "resp-1",
      "lab.ai.response_model": "deepseek-flash-0905",
      "lab.ai.usage.input_tokens": 100,
      "lab.ai.usage.output_tokens": 20,
      "lab.ai.usage.cache_read_tokens": 5,
      "lab.ai.usage.cache_write_tokens": 1,
      "lab.ai.usage.total_tokens": 126,
      "lab.ai.usage.cost": 0.002,
    });
    expect(request.attributes["lab.ai.error_message"]).toBeUndefined();
    expect(request.status).toEqual({ status: "ok" });
  });

  it("omits duration and reasoning attributes the message does not carry, instead of writing 0", async () => {
    const target = bridge();
    target.handleEvents([runStart, turnStart, { type: "message_end", entry: entry(11, assistant()) }]);
    await flush();
    const request = findByName(target.telemetry.getSpans(), "lab.ai.request")[0]!;
    expect("lab.ai.duration_ms" in request.attributes).toBe(false);
    expect("lab.ai.usage.reasoning_tokens" in request.attributes).toBe(false);
  });

  it("records an error or aborted response as an error span carrying the provider's message", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "message_end", entry: entry(11, assistant({ stopReason: "error", errorMessage: "401 invalid api key" })) },
    ]);
    await flush();
    const request = findByName(target.telemetry.getSpans(), "lab.ai.request")[0]!;
    expect(request.status).toEqual({ status: "error" });
    expect(request.attributes).toMatchObject({ "lab.ai.stop_reason": "error", "lab.ai.error_message": "401 invalid api key" });
  });

  it("treats a tool_execution_end with no entry as a faulted tool, not a success", async () => {
    const target = bridge();
    target.handleEvents([runStart, turnStart, toolStart, { type: "tool_execution_end", toolCallId: "call-1", toolName: "get_booking" }]);
    await flush();
    const tool = findByName(target.telemetry.getSpans(), "lab.tool")[0]!;
    expect(tool.attributes["lab.tool.outcome"]).toBe("faulted");
    expect("lab.tool.is_error" in tool.attributes).toBe(false);
    expect(tool.status).toEqual({ status: "error" });
  });

  it("marks an errored tool result as an error span", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      toolStart,
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "get_booking", entry: entry(13, toolResult(true)) },
    ]);
    await flush();
    const tool = findByName(target.telemetry.getSpans(), "lab.tool")[0]!;
    expect(tool.attributes).toMatchObject({ "lab.tool.outcome": "result", "lab.tool.is_error": true });
    expect(tool.status).toEqual({ status: "error" });
  });

  it("reads each tool's replay policy from the registry map, and defaults an unregistered tool to unsafe with a warning", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "tool_execution_start", toolCallId: "call-9", toolName: "update_booking_status", args: {} },
      { type: "tool_execution_start", toolCallId: "call-10", toolName: "mystery_tool", args: {} },
    ]);
    await flush();
    const [update, mystery] = findByName(target.telemetry.getSpans(), "lab.tool");
    expect(update!.attributes["lab.tool.replay"]).toBe("unsafe");
    expect(mystery!.attributes["lab.tool.replay"]).toBe("unsafe");
    expect(target.warnings.some((warning) => warning.includes("unregistered tool"))).toBe(true);
  });

  it("bridges auto_retry_start/end into a lab.retry span under the open turn", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "503 overloaded" },
      { type: "auto_retry_end", attempt: 1 },
    ]);
    await flush();
    const spans = target.telemetry.getSpans();
    const retry = findByName(spans, "lab.retry")[0]!;
    expect(retry.parentId).toBe(findByName(spans, "lab.turn")[0]!.id);
    expect(retry.attributes).toMatchObject({ "lab.retry.attempt": 1, "lab.retry.reason": "503 overloaded" });
    expect(retry.settled).toBe(true);
  });

  it("opens compaction as a root span, even while a run is open", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      { type: "compaction_start", taskId: id(30), reason: "threshold", blocking: false },
      { type: "compaction_end", taskId: id(30), reason: "threshold" },
      runEnd,
    ]);
    await flush();
    const compaction = findByName(target.telemetry.getSpans(), "lab.compaction")[0]!;
    expect(compaction.parentId).toBeNull();
    expect(compaction.attributes).toMatchObject({ "lab.compaction.reason": "threshold", "lab.compaction.blocking": false, "lab.compaction.task_id": "30" });
    expect(compaction.settled).toBe(true);
  });

  it("gives sibling turns under one run consecutive numbers", async () => {
    const target = bridge();
    target.handleEvents([runStart, turnStart, turnEnd, turnStart, turnEnd, runEnd]);
    await flush();
    const turns = findByName(target.telemetry.getSpans(), "lab.turn");
    expect(turns.map((turn) => turn.attributes["lab.turn.number"])).toEqual([1, 2]);
    expect(new Set(turns.map((turn) => turn.parentId)).size).toBe(1);
  });

  it("does not turn the attach-time snapshot into spans, and warns when a snapshot interrupts open spans", async () => {
    const target = bridge();
    const snapshot = { type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as unknown as AgentEvent;
    target.handleEvents([snapshot]);
    expect(target.telemetry.getSpans()).toHaveLength(0);
    expect(target.warnings).toEqual([]);

    target.handleEvents([runStart, snapshot]);
    expect(target.warnings.some((warning) => warning.includes("overflowed"))).toBe(true);
  });

  // The harness refuses an unknown tool, invalid arguments, or a blocked call without running it: it commits an
  // error result and emits tool_execution_end with NO tool_execution_start. That is a normal run.
  it("turns a tool_execution_end with no start but an error result into a refused tool span, with no warning", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "tool_execution_end", toolCallId: "call-7", toolName: "update_booking_status", entry: entry(13, toolResult(true)) },
    ]);
    await flush();
    const spans = target.telemetry.getSpans();
    const tool = findByName(spans, "lab.tool")[0]!;
    expect(tool.parentId).toBe(findByName(spans, "lab.turn")[0]!.id);
    expect(tool.attributes).toMatchObject({
      "lab.tool.name": "update_booking_status",
      "lab.tool.call_id": "call-7",
      "lab.tool.replay": "unsafe",
      "lab.tool.outcome": "refused",
      "lab.tool.is_error": true,
    });
    expect(tool.status).toEqual({ status: "error" });
    expect(tool.settled).toBe(true);
    expect(target.warnings).toEqual([]);
  });

  it("gives a refused call to an unregistered tool the default replay policy, without a warning", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "tool_execution_end", toolCallId: "call-8", toolName: "delete_everything", entry: entry(13, toolResult(true)) },
    ]);
    await flush();
    const tool = findByName(target.telemetry.getSpans(), "lab.tool")[0]!;
    expect(tool.attributes).toMatchObject({ "lab.tool.replay": "unsafe", "lab.tool.outcome": "refused" });
    expect(target.warnings).toEqual([]);
  });

  it("still warns for an end with no start AND no error result — a lost start, not a refusal", async () => {
    const target = bridge();
    target.handleEvents([
      runStart,
      turnStart,
      { type: "tool_execution_end", toolCallId: "call-9", toolName: "get_booking", entry: entry(13, toolResult(false)) },
    ]);
    await flush();
    expect(findByName(target.telemetry.getSpans(), "lab.tool")).toHaveLength(0);
    expect(target.warnings).toHaveLength(1);
    expect(target.warnings[0]).toContain("no error result");
  });

  it("never throws on an _end event with no matching _start and no entry at all, and records a warning", () => {
    const target = bridge();
    expect(() =>
      target.handleEvents([
        { type: "tool_execution_end", toolCallId: "ghost", toolName: "get_booking" },
        { type: "auto_retry_end", attempt: 7 },
        { type: "compaction_end", taskId: id(99), reason: "manual" },
      ]),
    ).not.toThrow();
    expect(target.warnings).toHaveLength(3);
  });

  it("finish() closes spans a stopped stream left open, with an Unfinished error status, and is idempotent", async () => {
    const target = bridge();
    target.handleEvents([runStart, turnStart, toolStart]);
    await flush();
    expect(target.telemetry.getSpans().every((span) => !span.settled)).toBe(true);

    target.finish();
    target.finish();
    await flush();
    const spans = target.telemetry.getSpans();
    expect(spans.every((span) => span.settled)).toBe(true);
    expect(spans.every((span) => span.status.status === "error" && span.status.error?.name === "Unfinished")).toBe(true);
    expect(target.warnings.filter((warning) => warning.includes("still open at finish()"))).toHaveLength(1);
  });

  // The settle finding, pinned: attributes written before the resolve are visible at once, `settled` is not.
  it("shows end attributes immediately but only reports settled after a microtask flush", async () => {
    const target = bridge();
    target.handleEvents([runStart, runEnd]);
    expect(findByName(target.telemetry.getSpans(), "lab.run")[0]!.settled).toBe(false);
    await flush();
    expect(findByName(target.telemetry.getSpans(), "lab.run")[0]!.settled).toBe(true);
  });
});
