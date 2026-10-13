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
   * future callbacks, not to flush pending frames, so callers wait here before stopping. If the
   * event never arrives within `timeoutMs`, a visible warning line is written and the wait ends.
   */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  /**
   * Writes one tagged line at the current depth for something the event stream does not carry — an egress
   * guard hook withholding a value, or declining a compaction. Hooks run beside the stream, not in it.
   */
  note(text: string): void;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /** Prefix on every line, e.g. `c1`, so the lines of two conversations stay distinguishable in one log. */
  tag?: string;
  /**
   * Applied to every line before it is written. A trace prints the model's tool-call arguments verbatim, and
   * a model can put anything in them — including a value this caller must not see — so the chat service
   * passes a redaction built from the same forbidden list the egress guards use.
   */
  redact?: (text: string) => string;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `ID@version` for each source a document tool's `details` names, or `undefined` when the entry carries none. */
function sourcesOf(details: unknown): { sources: string[]; stale: string[]; conflicts: number } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as { sources?: unknown; staleSources?: unknown; conflicts?: unknown };
  const refs = (value: unknown): string[] =>
    Array.isArray(value) ? value.flatMap((item) => (typeof item === "object" && item !== null && typeof (item as { sourceId?: unknown }).sourceId === "string" ? [`${(item as { sourceId: string }).sourceId}@${String((item as { version?: unknown }).version)}`] : [])) : [];
  if (!Array.isArray(record.sources)) return undefined;
  return { sources: refs(record.sources), stale: refs(record.staleSources), conflicts: Array.isArray(record.conflicts) ? record.conflicts.length : 0 };
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree, in the same
 * `▶`/`◀` bracket style as the earlier labs. `watchEvents` is derived from storage commits, not from
 * callbacks inside a live agent loop: the events describe what was durably committed, in commit order.
 *
 * The model's *request* and Pi's *execution* are separate lines, paired by the shared `call=` id:
 * `assistant (tool call) name call=<id> args=<json>` is what the model asked for, and what follows is
 * what the harness did about it. This lab's tracer separates three outcomes that a bare `status=error`
 * would blur together:
 *
 * - `▶ tool_start` … `◀ tool_end status=success` — the call passed every gate and `execute()` ran.
 * - `▶ tool_start` … `◀ tool_end status=error code=tool_error` — `execute()` ran and threw.
 * - `⊘ tool_refused code=<code>` — the harness wrote an error result **without ever starting the
 *   tool**: `tool_unavailable` (not offered), `invalid_arguments`, or `blocked` (a `beforeTool` hook
 *   declined, or threw). A refused call emits `tool_execution_end` but never `tool_execution_start`,
 *   so a tracer that only draws start/end pairs would either show nothing or show an orphan end.
 *
 * The `code` is the machine-readable diagnostic the harness stored on the `pi.tool-result` entry, the
 * one field that tells these apart; `isError` cannot. Only "run" and "turn" are LIFO spans; a tool
 * line prints at the current depth so overlapping calls stay siblings.
 *
 * This lab adds what its tools make visible. A document tool's result line names the sources it carried
 * (`sources=[KB-100@2]`, plus `stale=[…]` and `conflicts=N` when there are any), taken from the `details` the
 * tool stored — the same record later revocation checks read — so a trace shows which sources entered the
 * conversation, not just that a tool ran. Hooks run beside the event stream, so what the egress guard does is
 * written through `note()`: `⛔ egress_withheld` (a value was replaced in a request) or `⛔ compaction_declined`.
 *
 * `message_start`, `message_update`, `tool_execution_update`, `usage_changed`, and `inbox_update` are
 * not rendered: every fact they would add is already on a `message_end` / `tool_execution_end` line.
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
  const redact = options.redact ?? ((text: string) => text);
  const emit = (text: string) => write(redact(`${tag}${pad()}${text}`));
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
          const code = errorDiagnostic(event.entry)?.code;
          const evidence = sourcesOf(message.details);
          const carried = evidence
            ? ` sources=[${evidence.sources.join(",")}]${evidence.stale.length > 0 ? ` stale=[${evidence.stale.join(",")}]` : ""}${evidence.conflicts > 0 ? ` conflicts=${evidence.conflicts}` : ""}`
            : "";
          emit(
            `toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${code ? ` code=${code}` : ""}${carried} ${entry}`,
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
        const result = event.entry?.model?.[0];
        const failed = result?.role === "toolResult" && result.isError;
        const diagnostic = errorDiagnostic(event.entry);
        if (!startedCalls.delete(event.toolCallId)) {
          // No start was ever emitted for this call: the harness refused it before execution.
          const reason = diagnostic ? ` reason="${oneLine(diagnostic.message)}"` : "";
          emit(`⊘ tool_refused ${event.toolName} call=${event.toolCallId} code=${diagnostic?.code ?? "unknown"}${reason}`);
        } else if (event.entry === undefined) {
          emit(`◀ tool_end ${event.toolName} call=${event.toolCallId} status=unknown (task faulted, no result entry)`);
        } else {
          // An error that ran `execute()` says why (for this lab: not permitted, no such booking), so a
          // reader does not have to open the entry to tell a policy refusal from a lookup miss.
          const reason = failed && diagnostic ? ` reason="${oneLine(diagnostic.message)}"` : "";
          emit(
            `◀ tool_end ${event.toolName} call=${event.toolCallId} status=${failed ? "error" : "success"}${diagnostic ? ` code=${diagnostic.code}` : ""}${reason}`,
          );
        }
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
    note(text) {
      emit(text);
    },
    async stop() {
      await stream.stop();
    },
  };
}
