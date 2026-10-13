import type { Context } from "@earendil-works/chord";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

import { messageText } from "./transcript.js";

export type TraceWriter = (line: string) => void;

export interface TraceHandle {
  /**
   * Resolves once the trace has rendered every line up to this submission's terminal `submission`
   * event, which the stream delivers after `run_end`. `WatchHandle.stop()` only promises to stop
   * future callbacks, not to flush pending frames, so callers wait here before stopping. If the
   * event never arrives within `timeoutMs`, a visible warning line is written and the wait ends.
   */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /** Prefix on every line, e.g. `c20`, so the lines of two branches stay distinguishable in one log. */
  tag?: string;
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree — the same
 * `▶`/`◀` bracket style as the earlier labs' loggers. `watchEvents` is a stream derived from storage
 * commits, one batch per commit, not callbacks fired from inside a live agent loop: the events describe
 * what was durably committed, in commit order.
 *
 * A session with forks has one stream per conversation; attach one logger to each and give each a `tag`.
 * Creating a fork produces no event on either side — the fork is a commit of a new conversation record,
 * not an entry — so callers print it themselves (`describeFork`). The snapshot a stream delivers at
 * attachment holds the inherited and earlier entries and is deliberately not replayed as trace output.
 *
 * The model's *request* and Pi's *execution* are separate lines: `assistant (tool call) name call=<id>
 * args=<json>` is what the model asked for, and the `tool_start`/`tool_end` pair below it is the harness
 * running it; the shared `call=` id pairs them. Only "run" and "turn" are genuine LIFO spans. A tool call
 * prints as a plain line at the current depth, so overlapping tool calls stay siblings instead of
 * corrupting every indent after them.
 *
 * `message_start`, `message_update`, `tool_execution_update`, `usage_changed`, and `inbox_update` are not
 * rendered: every fact they would add (role, entry id, outcome) is already on the matching `message_end` /
 * `tool_execution_end` line. A terminal `submission` event is consumed only to release `settled()`.
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

  const settledIds = new Set<SubmissionId>();
  const waiters = new Map<SubmissionId, () => void>();

  const render = (event: AgentEvent): void => {
    switch (event.type) {
      case "submission":
        if (event.record.status === "done" || event.record.status === "unanswered") {
          settledIds.add(event.record.id);
          waiters.get(event.record.id)?.();
        }
        break;
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
          if (message.errorMessage) {
            emit(`assistant (${message.stopReason}) ${message.errorMessage} ${entry}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) {
              emit(`[Assistant] ${entry} ${text}`);
            }
            for (const call of toolCalls) {
              emit(`assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)} ${entry}`);
            }
            if (!text && toolCalls.length === 0) {
              emit(`assistant (empty) ${entry}`);
            }
          }
        }
        break;
      }
      case "tool_execution_start":
        emit(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        const result = event.entry?.model?.[0];
        const failed = result?.role === "toolResult" && result.isError;
        emit(`◀ tool_end ${event.toolName} status=${failed ? "error" : "success"}`);
        break;
      }
      case "auto_retry_start":
        emit(`↻ retry attempt=${event.attempt} ${event.errorMessage}`);
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
    settled(submissionId, timeoutMs = 5000) {
      if (settledIds.has(submissionId)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(submissionId);
          emit(`trace: no settle event for submission ${submissionId} within ${timeoutMs}ms`);
          resolve();
        }, timeoutMs);
        waiters.set(submissionId, () => {
          clearTimeout(timer);
          waiters.delete(submissionId);
          resolve();
        });
      });
    },
    async stop() {
      await stream.stop();
    },
  };
}
