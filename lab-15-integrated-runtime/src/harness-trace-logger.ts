import type { Context } from "@earendil-works/chord";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

import { createSettleTracker } from "./settle.js";
import { errorDiagnostic, messageText } from "./transcript.js";

export type TraceWriter = (line: string) => void;

export interface TraceHandle {
  /**
   * Resolves once the trace has rendered every line up to this submission's terminal `submission` event,
   * which the stream delivers after `run_end`. If the event never arrives within `timeoutMs`, a visible
   * warning line is written and the wait ends.
   */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /**
   * Prefix on every line, so the lines of several requests stay distinguishable in one log. A function is
   * read on every line: Lab 15 passes the request id of whichever request is in flight, so one tracer
   * attached to the root conversation labels each request's lines with that request's id. `undefined`
   * (no request in flight, e.g. a recovered run) prints no prefix rather than a made-up one.
   */
  tag?: string | (() => string | undefined);
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree — the same `▶`/`◀`
 * bracket style as Labs 01-11's loggers. `watchEvents` is derived from storage commits, one batch per
 * commit, not callbacks from inside a live agent loop: the lines describe what was durably committed, in
 * commit order. The snapshot delivered at attachment holds earlier entries and is deliberately not replayed.
 *
 * The model's *request* and Pi's *execution* are separate lines: `assistant (tool call) name call=<id>
 * args=<json>` is what the model asked for, and the `tool_start`/`tool_end` pair below it is the harness
 * running it; the shared `call=` id pairs them. Only "run" and "turn" are genuine LIFO spans — a tool call
 * prints as a plain line at the current depth, so overlapping calls stay siblings instead of corrupting
 * every indent after them.
 *
 * Added in Lab 14: every assistant line ends with `(stop=… tokens=… …ms)`, read from the committed
 * assistant message — the same three facts the telemetry bridge records on `lab.ai.request`, so a reader can
 * compare the human trace against the span capture line by line. `duration` is omitted when the message
 * carries no `durationMs` (legacy or deferred results), never printed as 0.
 *
 * Added in Lab 15: the three ways a tool call can end in an error are no longer one `status=error`. The
 * harness stores a machine-readable `code` on the result entry (`blocked`, `tool_unavailable`,
 * `invalid_arguments`, `tool_error`, …) and the tracer prints it:
 *
 * - `▶ tool_start` … `◀ tool_end status=success` — every gate passed and `execute()` ran.
 * - `▶ tool_start` … `◀ tool_end status=error code=tool_error` — `execute()` ran and threw.
 * - `⊘ tool_refused code=<code> reason=…` — the harness wrote an error result **without starting the
 *   tool** (not offered, invalid arguments, or a `beforeTool` hook blocked or threw). Such a call emits
 *   `tool_execution_end` with no `tool_execution_start`, so a tracer that only drew start/end pairs would
 *   show an orphan end or nothing. Which hook blocked it is not on the result; the audit record says.
 *
 * `message_start`, `message_update`, `tool_execution_update`, `usage_changed`, and `inbox_update` are not
 * rendered: every fact they would add is already on the matching `message_end` / `tool_execution_end` line.
 */
export async function attachTraceLogger(
  harness: Harness,
  conversationId: ConversationId,
  write: TraceWriter,
  context: Context,
  options: TraceOptions = {},
): Promise<TraceHandle> {
  type Span = "run" | "turn";
  const stack: Span[] = [];
  const currentTag = (): string => {
    const value = typeof options.tag === "function" ? options.tag() : options.tag;
    return value === undefined ? "" : `[${value}] `;
  };
  const pad = () => "  ".repeat(stack.length);
  const emit = (text: string) => write(`${currentTag()}${pad()}${text}`);
  const open = (kind: Span, text: string) => {
    emit(text);
    stack.push(kind);
  };
  const close = (kind: Span, text: string) => {
    if (stack[stack.length - 1] === kind) {
      stack.pop();
    }
    emit(text);
  };

  let turnNumber = 0;
  let toolResultsInTurn = 0;
  const tracker = createSettleTracker();
  const startedCalls = new Set<string>();

  const render = (event: AgentEvent): void => {
    tracker.observe(event);
    switch (event.type) {
      case "run_start":
        open("run", `▶ run inputs=[${event.inputs.join(",")}]`);
        break;
      case "turn_start":
        turnNumber += 1;
        toolResultsInTurn = 0;
        open("turn", `▶ turn #${turnNumber}`);
        break;
      case "message_end": {
        const message = event.entry.model?.[0];
        const entry = `entry=${event.entry.id}`;
        if (!message) {
          emit(`${event.entry.kind} ${entry}`);
        } else if (message.role === "user") {
          emit(`user       "${messageText(message)}" ${entry}`);
        } else if (message.role === "system") {
          emit(`system     (prompt and tool changes) ${entry}`);
        } else if (message.role === "toolResult") {
          toolResultsInTurn += 1;
          const code = errorDiagnostic(event.entry)?.code;
          emit(`toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${code ? ` code=${code}` : ""} ${entry}`);
        } else {
          const text = messageText(message);
          const toolCalls = message.content.filter((block) => block.type === "toolCall");
          const facts =
            `(stop=${message.stopReason} tokens=${message.usage.totalTokens}` +
            `${message.durationMs === undefined ? "" : ` ${Math.round(message.durationMs)}ms`})`;
          if (message.errorMessage) {
            emit(`assistant (${message.stopReason}) ${message.errorMessage} ${entry} ${facts}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) {
              emit(`[Assistant] ${entry} ${facts} ${text}`);
            }
            for (const call of toolCalls) {
              emit(`assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)} ${entry} ${facts}`);
            }
            if (!text && toolCalls.length === 0) {
              emit(`assistant (empty) ${entry} ${facts}`);
            }
          }
        }
        break;
      }
      case "tool_execution_start":
        startedCalls.add(event.toolCallId);
        emit(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        const result = event.entry?.model?.[0];
        const diagnostic = errorDiagnostic(event.entry);
        if (!startedCalls.delete(event.toolCallId)) {
          // No start was ever emitted for this call: the harness refused it before execution.
          const reason = diagnostic ? ` reason="${oneLine(diagnostic.message)}"` : "";
          emit(`⊘ tool_refused ${event.toolName} call=${event.toolCallId} code=${diagnostic?.code ?? "unknown"}${reason}`);
          break;
        }
        // No entry at all means the tool task faulted or was orphaned — a failure, not a success.
        const status = event.entry === undefined ? "faulted" : result?.role === "toolResult" && result.isError ? "error" : "success";
        emit(`◀ tool_end ${event.toolName} call=${event.toolCallId} status=${status}${diagnostic ? ` code=${diagnostic.code}` : ""}`);
        break;
      }
      case "auto_retry_start":
        emit(`↻ retry attempt=${event.attempt} ${event.errorMessage}`);
        break;
      case "compaction_start":
        emit(`◇ compaction_start task=${event.taskId} reason=${event.reason} blocking=${event.blocking}`);
        break;
      case "compaction_end":
        emit(`◇ compaction_end task=${event.taskId} reason=${event.reason}`);
        break;
      case "turn_end":
        close("turn", `◀ turn_end #${turnNumber} tool_results=${toolResultsInTurn}`);
        break;
      case "run_end":
        close("run", `◀ run_end inputs=[${event.inputs.join(",")}]`);
        break;
      default:
        break;
    }
  };

  const stream = await watchEvents(harness, conversationId, context);
  stream.start(async (events) => {
    for (const event of events) {
      render(event);
    }
  });

  return {
    settled: (submissionId, timeoutMs) =>
      tracker.settled(submissionId, timeoutMs, (message) => emit(`trace: ${message}`)),
    async stop() {
      await stream.stop();
    },
  };
}
