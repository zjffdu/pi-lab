import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

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

function textOf(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  if (message.role === "assistant" || message.role === "toolResult") {
    return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return "";
}

/**
 * Renders a conversation's committed event stream as an indented run/turn/tool tree — the same
 * `▶`/`◀` bracket style as the earlier labs' loggers. `watchEvents` is a stream derived from
 * storage commits, one batch per commit, not callbacks fired from inside a live agent loop: the
 * events describe what was durably committed, in commit order.
 *
 * Only "run" and "turn" are genuine LIFO spans. A tool call prints as a plain line at the
 * current depth, so overlapping tool calls (a later lab) stay siblings instead of corrupting
 * every indent after them.
 *
 * Recovery is visible in the shape of the tree. A process that reopens a crashed session starts
 * mid-run: the first events it sees close a turn and a run that opened in the previous process,
 * so the logger opens them itself, marked `↺`, instead of printing a `◀` with nothing to close.
 * `↺` therefore means "this span began before the restart". A `tool_end` whose `tool_start` this
 * process never saw is a call a previous process started. Recovery resolves it one of two ways, and the
 * line says which: an `unsafe` call is closed with an `interrupted` error result and not run again; a
 * `safe` call is run again and its real result committed.
 *
 * The model's *request* and Pi's *execution* are separate lines: `assistant (tool call) name call=<id>
 * args=<json>` is what the model asked for, and the `tool_start`/`tool_end` pair below it is the harness
 * running it. The `call=` id pairs the two. One line is printed per requested call, alongside any text.
 *
 * `message_start`, `message_update`, `tool_execution_update`, `usage_changed`, and `inbox_update` are
 * not rendered: every fact they would add (role, entry id, outcome) is already on the matching
 * `message_end` / `tool_execution_end` line. A terminal `submission` event is consumed only to
 * release `settled()`; the CLI prints the submission's outcome itself. The snapshot delivered at attachment
 * holds the transcript from earlier processes and is deliberately not replayed as trace output.
 */
export async function attachTraceLogger(
  harness: Harness,
  conversationId: ConversationId,
  write: TraceWriter,
  context: Context,
): Promise<TraceHandle> {
  type Span = "run" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  const open = (kind: Span, text: string) => {
    write(`${pad()}${text}`);
    stack.push(kind);
  };
  const close = (kind: Span, text: string) => {
    if (stack[stack.length - 1] === kind) {
      stack.pop();
    }
    write(`${pad()}${text}`);
  };

  let turnNumber = 0;
  let toolResultsInTurn = 0;
  const startedCalls = new Set<string>();

  // Events of a run/turn that opened in a previous process arrive without their `*_start`.
  const resumeSpans = (needTurn: boolean): void => {
    if (!stack.includes("run")) {
      open("run", "↺ ▶ run (began before the restart)");
    }
    if (needTurn && !stack.includes("turn")) {
      turnNumber += 1;
      toolResultsInTurn = 0;
      open("turn", `↺ ▶ turn #${turnNumber} (began before the restart)`);
    }
  };

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
        if (message && message.role !== "user") {
          resumeSpans(true);
        }
        const entry = `entry=${event.entry.id}`;
        if (!message) {
          write(`${pad()}${event.entry.kind} ${entry}`);
        } else if (message.role === "user") {
          write(`${pad()}user       "${textOf(message)}" ${entry}`);
        } else if (message.role === "system") {
          write(`${pad()}system     (prompt and tool changes) ${entry}`);
        } else if (message.role === "toolResult") {
          toolResultsInTurn += 1;
          write(`${pad()}toolResult ${message.toolName} status=${message.isError ? "error" : "success"} ${entry}`);
        } else {
          const text = textOf(message);
          const toolCalls = message.content.filter((block) => block.type === "toolCall");
          if (message.errorMessage) {
            write(`${pad()}assistant (${message.stopReason}) ${message.errorMessage} ${entry}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) {
              write(`${pad()}[Assistant] ${entry} ${text}`);
            }
            for (const call of toolCalls) {
              write(`${pad()}assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)} ${entry}`);
            }
            if (!text && toolCalls.length === 0) {
              write(`${pad()}assistant (empty) ${entry}`);
            }
          }
        }
        break;
      }
      case "tool_execution_start":
        resumeSpans(true);
        startedCalls.add(event.toolCallId);
        write(`${pad()}▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        resumeSpans(true);
        const result = event.entry?.model?.[0];
        const failed = result?.role === "toolResult" && result.isError;
        // The stream carries no `tool_execution_start` for a call a previous process started, whichever way recovery
        // resolves it. The result entry tells the two policies apart: an unsafe call is closed with an `interrupted`
        // diagnostic and is never run again; a safe call was run again, so its result is the real one.
        const diagnostics = (event.entry?.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics;
        const wasInterrupted = diagnostics?.some((diagnostic) => diagnostic.code === "interrupted") ?? false;
        const recovery = startedCalls.has(event.toolCallId)
          ? ""
          : wasInterrupted
            ? " ↺ interrupted: the previous process died mid-call; recovery committed an error result and did not run the tool again"
            : " ↺ no tool_start in this process: recovery ran the call again";
        write(`${pad()}◀ tool_end ${event.toolName} status=${failed ? "error" : "success"}${recovery}`);
        break;
      }
      case "auto_retry_start":
        write(`${pad()}↻ retry attempt=${event.attempt} ${event.errorMessage}`);
        break;
      case "turn_end":
        resumeSpans(true);
        close("turn", `◀ turn_end #${turnNumber} tool_results=${toolResultsInTurn}`);
        break;
      case "run_end":
        resumeSpans(false);
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
          write(`${pad()}trace: no settle event for submission ${submissionId} within ${timeoutMs}ms`);
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
