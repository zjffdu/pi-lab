import type { Context } from "@earendil-works/chord";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";

import type { AttemptRecord } from "./connector/trace.js";
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
  /** A line the application adds after the run, such as why it was stopped; not part of the event stream. */
  note(text: string): void;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /** Prefix on every line, e.g. `alice`, so the lines of two conversations stay distinguishable in one log. */
  tag?: string;
  /**
   * The connector's HTTP attempts for one tool call, read when that call's `tool_execution_end` is
   * rendered. They are not live events: the stream is delivered from commits, so rows printed from a
   * callback would land in the wrong place. Reading them at the end of the call keeps each call's rows
   * directly under its own `tool_start`.
   */
  attemptsFor?: (toolCallId: string) => readonly AttemptRecord[];
}

/** Diagnostic codes for a call the harness answered *without running the tool*. */
const REFUSED_CODES: ReadonlySet<string> = new Set(["tool_unavailable", "invalid_arguments", "blocked"]);
/** Diagnostic codes for a call that was running when its process died or was aborted. */
const INTERRUPTED_CODES: ReadonlySet<string> = new Set(["interrupted"]);

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree in the same
 * `▶`/`◀` bracket style as the earlier labs. `watchEvents` is derived from storage commits, not from
 * callbacks inside a live loop: the events describe what was durably committed, in commit order.
 *
 * What a reader can tell from the tree (Lab 20's questions):
 *
 * - **Request versus execution.** `assistant (tool call) name call=<id> args=<json>` is what the model
 *   asked for, arguments included; what follows is what the harness did about it, paired by `call=`.
 * - **What each model call cost.** Every assistant line carries `tokens=<in>/<out>`, the provider-reported
 *   usage of that response; a run's total is the sum of the lines.
 * - **What the connector did.** Under a call, `↳ booking p1 try 2 rate_limited http=429 …` rows show each HTTP
 *   attempt the connector made for it, with the backoff or `Retry-After` it waited before that attempt. A
 *   call that shows one `↳` row and an error was *not* retried; one that shows three and then gave up was.
 * - **A limit refusing a call.** `⊘ tool_refused … code=blocked reason="BUDGET_EXHAUSTED…"` — the tool-call
 *   budget was spent, so the connector was never called: there are no `↳` rows. `tool_unavailable` and
 *   `invalid_arguments` take the same line. The `code` comes from the diagnostic the harness stored on the
 *   result entry, never from a missing `tool_execution_start` (a `replay: "safe"` tool re-executed by
 *   recovery has no start in the recovering process either, and is not a refusal).
 * - **A limit ending the run.** A turn, context, deadline, or cancellation stop is an abort, so it appears as a
 *   `◀ run_end` with no final answer; the application's reason is added afterwards as a `■ stopped` line.
 * - **Model retries.** `↻ retry attempt=…` is the harness retrying a failed provider call (the SDK's own retry is off).
 * - **Recovery.** A process that reopens a crashed session starts mid-run, so the first events it sees close a
 *   turn and a run that opened in the previous process; the logger opens them itself, marked `↺`.
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
          // Text from users and models is data: collapse it to one line so it cannot forge trace lines of its own.
        emit(`user       ${JSON.stringify(oneLine(messageText(message), 300))} ${entry}`);
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
          const tokens = `tokens=${message.usage.input}/${message.usage.output}`;
          if (message.errorMessage) {
            emit(`assistant (${message.stopReason}) ${oneLine(message.errorMessage)} ${entry} ${tokens}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            // A response cut off at the output limit says so: its text is a fragment, not an answer.
            const cut = message.stopReason === "length" ? " (cut off at the output limit)" : "";
            // `tokens=` is the usage of the whole message, so it is printed once — on the message's first line —
            // and a run's total is the sum of the `tokens=` figures.
            let first = true;
            const usageOnce = (): string => (first ? ((first = false), ` ${tokens}`) : "");
            if (text) {
              emit(`[Assistant]${cut} ${entry}${usageOnce()} ${oneLine(text, 2000)}`);
            }
            for (const call of toolCalls) {
              emit(`assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)} ${entry}${usageOnce()}`);
            }
            if (!text && toolCalls.length === 0) {
              emit(`assistant (empty) ${entry}${usageOnce()}`);
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
        for (const attempt of options.attemptsFor?.(event.toolCallId) ?? []) {
          const waited = attempt.waitBeforeMs > 0 ? ` waited=${attempt.waitBeforeMs}ms` : "";
          emit(`  ↳ ${attempt.route} p${attempt.page} try ${attempt.attempt} ${attempt.outcome}${attempt.httpStatus === undefined ? "" : ` http=${attempt.httpStatus}`} ${attempt.elapsedMs}ms${waited}`);
        }
        if (code !== undefined && REFUSED_CODES.has(code)) {
          emit(`⊘ tool_refused ${call} code=${code}${reason}`);
        } else if (code === "aborted") {
          emit(`⊘ tool_aborted ${call} code=aborted (${sawStart ? "the run was aborted while it was running" : "the run was aborted before it started"})`);
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
    note(text) {
      emit(`■ ${text}`);
    },
    async stop() {
      await stream.stop();
    },
  };
}
