import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  createTypedSpanStarter,
  type SpanAttributes,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

import type { ReplayPolicy } from "./create-harness.js";
import { createSettleTracker } from "./settle.js";
import {
  LAB_TELEMETRY_SCHEMA,
  type LabSpanEndAttributes,
  type LabSpanName,
  type LabSpanStartAttributes,
} from "./telemetry-schema.js";

export interface TelemetryBridgeOptions {
  telemetry: TelemetryContext;
  conversationId: string;
  /** `toolName -> declared replay policy` from `BookingRuntime` — the event stream does not carry it. */
  toolReplayByName: ReadonlyMap<string, ReplayPolicy>;
}

export interface TelemetryBridge {
  /** Feed one committed event batch (real from `watchEvents`, or synthetic in a test). Never throws. */
  handleEvents(events: readonly AgentEvent[]): void;
  /**
   * Closes every span still open — a stream that stopped mid-run — with an error status named
   * `Unfinished`. Call it after the stream has stopped. Idempotent.
   */
  finish(): void;
  /** Events this bridge could not map faithfully. Read after a run, never during one. */
  readonly warnings: readonly string[];
}

interface Pending {
  span: TelemetrySpan;
  startChild: SpanStarter;
  resolve: () => void;
}

type SpanStarter = (
  name: LabSpanName,
  attributes: SpanAttributes,
  callback: (span: TelemetrySpan, startChild: SpanStarter) => Promise<void>,
) => Promise<void>;

/**
 * `createTypedSpanStarter`'s return type is an intersection of one overload per span name, bound to one
 * parent. This bridge relays through one structurally-typed function instead of re-deriving that overload
 * set per span kind: the type safety lives in the attribute literals each `case` builds
 * (`satisfies LabSpanStartAttributes<"lab.run">`), which the compiler checks against `LAB_TELEMETRY_SCHEMA`.
 */
function relay(starter: unknown): SpanStarter {
  return starter as SpanStarter;
}

/**
 * Opens a span and returns its live handles at once, without waiting for the matching `_end` event. That works
 * because the starter invokes the callback *synchronously* (`pi-telemetry/dist/index.js` `bindTypedSpanStarter`
 * → `InMemoryTelemetryContext.startSpan`, `memory.js:63-123`) and only awaits what it returns. The span's real
 * lifetime is the returned `done` promise, resolved by `close()`.
 */
function open(starter: SpanStarter, name: LabSpanName, attributes: SpanAttributes): Pending {
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  let pending!: Pending;
  void starter(name, attributes, (span, startChild) => {
    pending = { span, startChild, resolve };
    return done;
  });
  return pending;
}

function close(pending: Pending | undefined, endAttributes: SpanAttributes, failed = false): void {
  if (!pending) return;
  pending.span.setAttributes(endAttributes);
  if (failed) pending.span.setStatus({ status: "error" });
  pending.resolve();
}

function isAssistant(message: { role: string } | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

/**
 * Bridges ONE conversation's committed event stream into `lab.*` spans on `options.telemetry`.
 *
 * Pi 1.1 opens no spans of its own (see `telemetry-schema.ts`), so everything below is reconstruction from
 * `watchEvents`. That stream is serialized and derived from commits, one conversation per stream, so a plain
 * stack is a faithful model of nesting: `run` → `turn` → { `ai.request`, `tool`, `retry` }. `compaction` is a
 * background task that belongs to no turn, so it is a root span. Events carry no run or turn ids; nesting is
 * positional, which is exactly as sound as the stream's ordering guarantee and no sounder.
 *
 * What this bridge cannot produce, and says so rather than guessing:
 * - **navigation**: `conversation.fork()` commits a conversation record, not an entry, so no event exists.
 * - **recovery**: Lab 08/09 showed a recovering process emits no `tool_execution_start` for the interrupted
 *   call, and the 1.1 stream has no `recovery` flag — there is nothing to set a recovery attribute from.
 */
export function createTelemetryBridge(options: TelemetryBridgeOptions): TelemetryBridge {
  const root = relay(createTypedSpanStarter(options.telemetry, [LAB_TELEMETRY_SCHEMA]));
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  let run: Pending | undefined;
  let turn: Pending | undefined;
  let turnNumber = 0;
  let toolResultsInTurn = 0;
  const tools = new Map<string, Pending>();
  const retries = new Map<number, Pending>();
  const compactions = new Map<string, Pending>();

  const parent = (): SpanStarter => turn?.startChild ?? run?.startChild ?? root;

  function handle(event: AgentEvent): void {
    switch (event.type) {
      case "snapshot": {
        if (run || turn || tools.size > 0 || retries.size > 0) {
          warn("snapshot received while spans were open: the stream overflowed and undelivered events were replaced");
        }
        return;
      }
      case "run_start": {
        if (run) warn("run_start while a run span was still open");
        const attributes = {
          "lab.conversation.id": options.conversationId,
          "lab.run.input_count": event.inputs.length,
        } satisfies LabSpanStartAttributes<"lab.run">;
        run = open(root, "lab.run", attributes);
        return;
      }
      case "turn_start": {
        turnNumber += 1;
        toolResultsInTurn = 0;
        if (!run) warn("turn_start with no open run: the turn span becomes a root span");
        const attributes = {
          "lab.conversation.id": options.conversationId,
          "lab.turn.number": turnNumber,
        } satisfies LabSpanStartAttributes<"lab.turn">;
        turn = open(run?.startChild ?? root, "lab.turn", attributes);
        return;
      }
      case "message_end": {
        const message = event.entry.model?.[0];
        if (message?.role === "toolResult") {
          toolResultsInTurn += 1;
        }
        if (!isAssistant(message)) return;

        // The provider request is a point in the committed stream: the assistant message already carries
        // everything (usage, stop reason, duration), so there is no start/usage correlation to guess at.
        const startAttributes = {
          "lab.ai.provider": message.provider,
          "lab.ai.model": message.model,
          "lab.ai.api": message.api,
        } satisfies LabSpanStartAttributes<"lab.ai.request">;
        const pending = open(parent(), "lab.ai.request", startAttributes);
        const endAttributes = {
          ...(message.responseModel === undefined ? {} : { "lab.ai.response_model": message.responseModel }),
          ...(message.responseId === undefined ? {} : { "lab.ai.response_id": message.responseId }),
          "lab.ai.stop_reason": message.stopReason,
          ...(message.errorMessage === undefined ? {} : { "lab.ai.error_message": message.errorMessage }),
          ...(message.durationMs === undefined ? {} : { "lab.ai.duration_ms": message.durationMs }),
          "lab.ai.usage.input_tokens": message.usage.input,
          "lab.ai.usage.output_tokens": message.usage.output,
          "lab.ai.usage.cache_read_tokens": message.usage.cacheRead,
          "lab.ai.usage.cache_write_tokens": message.usage.cacheWrite,
          ...(message.usage.reasoning === undefined ? {} : { "lab.ai.usage.reasoning_tokens": message.usage.reasoning }),
          "lab.ai.usage.total_tokens": message.usage.totalTokens,
          "lab.ai.usage.cost": message.usage.cost.total,
        } satisfies LabSpanEndAttributes<"lab.ai.request">;
        close(pending, endAttributes, message.stopReason === "error" || message.stopReason === "aborted");
        return;
      }
      case "tool_execution_start": {
        const replay = options.toolReplayByName.get(event.toolName);
        if (!replay) {
          warn(`tool_execution_start for unregistered tool "${event.toolName}": no declared replay policy, assuming "unsafe"`);
        }
        const attributes = {
          "lab.tool.name": event.toolName,
          "lab.tool.call_id": event.toolCallId,
          "lab.tool.replay": replay ?? "unsafe",
        } satisfies LabSpanStartAttributes<"lab.tool">;
        tools.set(event.toolCallId, open(parent(), "lab.tool", attributes));
        return;
      }
      case "tool_execution_end": {
        const pending = tools.get(event.toolCallId);
        if (!pending) {
          // A refused call — unknown tool, arguments that fail validation, or a blocking hook — never runs: the
          // harness commits an error tool result and emits `tool_execution_end` with NO `tool_execution_start`
          // (probed on this stack with a scripted model: a bad enum value and an unknown tool name both do it).
          // That is a normal run, not an anomaly, so it becomes a span of its own. An end with no start AND no
          // error result is something else — a lost start (an overflowed stream) or a bug — and still warns.
          const result = event.entry?.model?.[0];
          if (result?.role === "toolResult" && result.isError) {
            const attributes = {
              "lab.tool.name": event.toolName,
              "lab.tool.call_id": event.toolCallId,
              // The harness never ran it, so the declared policy is moot; an unregistered name has none.
              "lab.tool.replay": options.toolReplayByName.get(event.toolName) ?? "unsafe",
            } satisfies LabSpanStartAttributes<"lab.tool">;
            const endAttributes = { "lab.tool.outcome": "refused", "lab.tool.is_error": true } satisfies LabSpanEndAttributes<"lab.tool">;
            close(open(parent(), "lab.tool", attributes), endAttributes, true);
            return;
          }
          warn(`tool_execution_end for unobserved call ${event.toolCallId} with no error result: a lost start event, or a bug`);
          return;
        }
        tools.delete(event.toolCallId);
        const result = event.entry?.model?.[0];
        // `entry` is absent when the tool task faulted or was orphaned: that is a failure, not a success.
        const faulted = event.entry === undefined;
        const isError = faulted || (result?.role === "toolResult" && result.isError);
        const endAttributes = {
          "lab.tool.outcome": faulted ? "faulted" : "result",
          ...(faulted ? {} : { "lab.tool.is_error": isError }),
        } satisfies LabSpanEndAttributes<"lab.tool">;
        close(pending, endAttributes, isError);
        return;
      }
      case "auto_retry_start": {
        const attributes = {
          "lab.retry.attempt": event.attempt,
          "lab.retry.reason": event.errorMessage,
        } satisfies LabSpanStartAttributes<"lab.retry">;
        retries.set(event.attempt, open(parent(), "lab.retry", attributes));
        return;
      }
      case "auto_retry_end": {
        const pending = retries.get(event.attempt);
        if (!pending) {
          warn(`auto_retry_end for unobserved attempt ${event.attempt}`);
          return;
        }
        retries.delete(event.attempt);
        close(pending, {});
        return;
      }
      case "compaction_start": {
        const attributes = {
          "lab.conversation.id": options.conversationId,
          "lab.compaction.task_id": String(event.taskId),
          "lab.compaction.reason": event.reason,
          "lab.compaction.blocking": event.blocking,
        } satisfies LabSpanStartAttributes<"lab.compaction">;
        compactions.set(String(event.taskId), open(root, "lab.compaction", attributes));
        return;
      }
      case "compaction_end": {
        const key = String(event.taskId);
        const pending = compactions.get(key);
        if (!pending) {
          warn(`compaction_end for unobserved task ${key}`);
          return;
        }
        compactions.delete(key);
        close(pending, {});
        return;
      }
      case "turn_end": {
        const endAttributes = { "lab.turn.tool_result_count": toolResultsInTurn } satisfies LabSpanEndAttributes<"lab.turn">;
        close(turn, endAttributes);
        turn = undefined;
        return;
      }
      case "run_end": {
        close(run, {});
        run = undefined;
        return;
      }
      default:
        return;
    }
  }

  function finish(): void {
    const unfinished: Pending[] = [...tools.values(), ...retries.values(), ...compactions.values()];
    if (turn) unfinished.push(turn);
    if (run) unfinished.push(run);
    for (const pending of unfinished) {
      pending.span.setStatus({ status: "error", error: { name: "Unfinished", message: "the event stream stopped before the matching end event" } });
      pending.resolve();
    }
    if (unfinished.length > 0) warn(`${unfinished.length} span(s) were still open at finish()`);
    tools.clear();
    retries.clear();
    compactions.clear();
    turn = undefined;
    run = undefined;
  }

  return {
    handleEvents(events) {
      for (const event of events) {
        try {
          handle(event);
        } catch (error) {
          // A telemetry bug must never break the run it observes.
          warn(`bridge failed on ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    finish,
    warnings,
  };
}

export interface TelemetryHandle {
  bridge: TelemetryBridge;
  /** Resolves once the terminal `submission` event for `submissionId` was consumed, i.e. after its `run_end`. */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  /** Stops the stream, then closes any span still open. */
  stop(): Promise<void>;
}

/** Attaches the bridge to one conversation's `watchEvents` stream. One stream per conversation. */
export async function attachTelemetry(
  harness: Harness,
  conversationId: ConversationId,
  options: Omit<TelemetryBridgeOptions, "conversationId">,
  context: Context,
): Promise<TelemetryHandle> {
  const bridge = createTelemetryBridge({ ...options, conversationId: String(conversationId) });
  const tracker = createSettleTracker();
  const stream = await watchEvents(harness, conversationId, context);
  stream.start(async (events) => {
    for (const event of events) tracker.observe(event);
    bridge.handleEvents(events);
  });

  return {
    bridge,
    settled: (submissionId, timeoutMs) =>
      tracker.settled(submissionId, timeoutMs, (message) => (bridge.warnings as string[]).push(`telemetry: ${message}`)),
    async stop() {
      await stream.stop();
      bridge.finish();
    },
  };
}
