import type { Context } from "@earendil-works/chord";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

import { createSettleTracker } from "./settle.js";
import { messageText } from "./transcript.js";

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
  /** Prefix on every line, e.g. a case id, so the lines of several runs stay distinguishable in one log. */
  tag?: string;
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
 * Added for this lab: every assistant line ends with `(stop=… tokens=… …ms)`, read from the committed
 * assistant message — the same three facts the telemetry bridge records on `lab.ai.request`, so a reader can
 * compare the human trace against the span capture line by line. `duration` is omitted when the message
 * carries no `durationMs` (legacy or deferred results), never printed as 0.
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
  const tag = options.tag === undefined ? "" : `[${options.tag}] `;
  const pad = () => "  ".repeat(stack.length);
  const emit = (text: string) => write(`${tag}${pad()}${text}`);
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
          emit(`toolResult ${message.toolName} status=${message.isError ? "error" : "success"} ${entry}`);
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
        emit(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      // A refused call (unknown tool, invalid arguments, blocked) has a `tool_end` with no `tool_start` before it.
      case "tool_execution_end": {
        const result = event.entry?.model?.[0];
        // No entry at all means the tool task faulted or was orphaned — a failure, not a success.
        const status = event.entry === undefined ? "faulted" : result?.role === "toolResult" && result.isError ? "error" : "success";
        emit(`◀ tool_end ${event.toolName} call=${event.toolCallId} status=${status}`);
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
