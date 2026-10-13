import type { Context } from "@earendil-works/chord";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

import { errorDiagnostic, messageText } from "./transcript.js";

export type TraceWriter = (line: string) => void;

export interface TraceHandle {
  /**
   * Resolves once the trace has rendered every line up to this submission's terminal `submission`
   * event, which the stream delivers after `run_end`. `WatchHandle.stop()` only promises to stop
   * future callbacks, not to flush pending frames, so callers wait here before stopping. If the event
   * never arrives within `timeoutMs`, a visible warning line is written and the wait ends.
   */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /** Prefix on every line, e.g. `alice`, so the lines of two conversations stay distinguishable in one log. */
  tag?: string;
}

/** Diagnostic codes for a call the harness answered *without running the tool*. */
const REFUSED_CODES: ReadonlySet<string> = new Set(["tool_unavailable", "invalid_arguments", "blocked"]);
/** Diagnostic codes for a call that was running when its process died or was aborted. */
const INTERRUPTED_CODES: ReadonlySet<string> = new Set(["interrupted", "aborted"]);

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree in the same
 * `▶`/`◀` bracket style as the earlier labs. `watchEvents` is derived from storage commits, not from
 * callbacks inside a live loop: the events describe what was durably committed, in commit order.
 *
 * What a reader can tell from the tree (Lab 17's questions):
 *
 * - **Request versus execution.** `assistant (tool call) name call=<id> args=<json>` is what the model
 *   asked for, arguments included; what follows is what the harness did about it, paired by `call=`.
 * - **Capability refusal.** `⊘ tool_refused … code=tool_unavailable` — the tool is not in today's offer,
 *   so no code of ours ran: no authorization decision, no audit decision record, no effect.
 *   `invalid_arguments` and `blocked` take the same line. The `code` comes from the diagnostic the harness
 *   stored on the result entry, never from a missing `tool_execution_start`: a `replay: "safe"` tool
 *   re-executed by recovery has no start in the recovering process either, and is not a refusal.
 * - **Authorization denial.** `▶ tool_start` … `◀ tool_end status=error code=tool_error reason="…"` — the tool
 *   was offered and ran, and `BookingService` refused. The `reason` is the same text the model received.
 * - **What changed in the offer.** `system tools +[…] -[…]` shows each tool-set change the model's transcript
 *   carries, so "yesterday's offer, then today's removal" is visible in one run.
 * - **Recovery.** A process that reopens a crashed session starts mid-run, so the first events it sees
 *   close a turn and a run that opened in the previous process; the logger opens them itself, marked `↺`.
 *   `↺ tool_interrupted` is a call that was running when the process died and was not re-run; a
 *   `◀ tool_end … ↺ no tool_start in this process` is a safe call recovery re-executed.
 *
 * Only "run" and "turn" are LIFO spans; a tool line prints at the current depth so overlapping calls stay
 * siblings. `message_start`, `message_update`, `tool_execution_update`, `usage_changed`, and
 * `inbox_update` are not rendered: everything they would add is on a `message_end` / `tool_execution_end`
 * line.
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
        if (message && message.role !== "user" && message.role !== "system") {
          resumeSpans(true);
        }
        const entry = `entry=${event.entry.id}`;
        if (!message) {
          emit(`${event.entry.kind} ${entry}`);
        } else if (message.role === "user") {
          emit(`user       "${messageText(message)}" ${entry}`);
        } else if (message.role === "system") {
          const added = (message.toolsAdded ?? []).map((tool) => tool.name);
          const removed = (message.toolsRemoved ?? []).map((tool) => tool.name);
          const parts = [
            ...(added.length > 0 ? [`+[${added.join(",")}]`] : []),
            ...(removed.length > 0 ? [`-[${removed.join(",")}]`] : []),
          ];
          const sections = Object.keys(message.sections ?? {});
          emit(
            `system     ${parts.length > 0 ? `tools ${parts.join(" ")}` : "(no tool change)"}${sections.length > 0 ? ` prompt=[${sections.join(",")}]` : ""} ${entry}`,
          );
        } else if (message.role === "toolResult") {
          toolResultsInTurn += 1;
          const code = errorDiagnostic(event.entry)?.code;
          emit(
            `toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${code ? ` code=${code}` : ""} ${entry}`,
          );
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
        startedCalls.add(event.toolCallId);
        emit(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        resumeSpans(true);
        const result = event.entry?.model?.[0];
        const failed = result?.role === "toolResult" && result.isError;
        const diagnostic = errorDiagnostic(event.entry);
        const code = diagnostic?.code;
        const sawStart = startedCalls.delete(event.toolCallId);
        const reason = diagnostic ? ` reason="${oneLine(diagnostic.message)}"` : "";
        const call = `${event.toolName} call=${event.toolCallId}`;
        if (code !== undefined && REFUSED_CODES.has(code)) {
          emit(`⊘ tool_refused ${call} code=${code}${reason}`);
        } else if (code !== undefined && INTERRUPTED_CODES.has(code)) {
          emit(`↺ tool_interrupted ${call} code=${code} (running when its process died; not re-run)`);
        } else if (event.entry === undefined) {
          emit(`◀ tool_end ${call} status=unknown (task faulted, no result entry)`);
        } else {
          emit(
            `◀ tool_end ${call} status=${failed ? "error" : "success"}${code ? ` code=${code}` : ""}${reason}` +
              `${sawStart ? "" : " ↺ no tool_start in this process: re-executed by recovery"}`,
          );
        }
        break;
      }
      case "auto_retry_start":
        emit(`↻ retry attempt=${event.attempt} ${event.errorMessage}`);
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
