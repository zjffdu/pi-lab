import type { Context } from "@earendil-works/chord";
import { type AgentEvent, type ConversationId, type Harness, type SubmissionId, watchEvents } from "@earendil-works/pi-durable";

import { createSettleTracker } from "./settle.js";
import { errorDiagnostic, messageText } from "./transcript.js";

export type TraceWriter = (line: string) => void;

export interface TraceHandle {
  /**
   * Resolves once the trace has rendered every line up to this submission's terminal `submission` event,
   * which the stream delivers after `run_end`. `WatchHandle.stop()` only promises to stop future callbacks,
   * not to flush pending frames, so callers wait here before stopping. If the event never arrives within
   * `timeoutMs`, a visible warning line is written and the wait ends.
   */
  settled(submissionId: SubmissionId, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface TraceOptions {
  /** Prefix on every line, e.g. `req=1a2b3c4d tenant=tenant-a sub=alice`, so one request is findable in a shared log. */
  tag?: string;
  /**
   * What to print of message text. `"redacted"` (the default) prints only its length: the log of a
   * multi-tenant server is read by operators of every tenant, so booking contents and prompt text must not
   * land in it. `"full"` prints the text and is meant for a local run against synthetic data.
   * Tool-result *content* is never printed in either mode — a tool result is exactly where one tenant's
   * booking lives — only its status and diagnostic code. The tool call's arguments (what the model chose to
   * ask for) are printed.
   */
  text?: "redacted" | "full";
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Renders ONE conversation's committed event stream as an indented run/turn/tool tree in the same `▶`/`◀`
 * bracket style as the earlier labs. `watchEvents` is derived from storage commits, one batch per commit,
 * not callbacks from inside a live agent loop: the lines describe what was durably committed, in commit
 * order. The snapshot delivered at attachment holds earlier entries and is deliberately not replayed.
 *
 * The model's *request* and Pi's *execution* are separate lines, paired by the shared `call=` id:
 * `assistant (tool call) name call=<id> args=<json>` is what the model asked for, and what follows is what
 * the harness did about it. Three outcomes a bare `status=error` would blur together stay distinct:
 *
 * - `▶ tool_start` … `◀ tool_end status=success` — the call passed every gate and `execute()` ran.
 * - `▶ tool_start` … `◀ tool_end status=error code=tool_error` — `execute()` ran and threw.
 * - `⊘ tool_refused code=<code>` — the harness wrote an error result **without starting the tool**:
 *   `tool_unavailable`, `invalid_arguments` (this lab: a model that adds `tenantId` to `get_booking`), or
 *   `blocked`. A refused call emits `tool_execution_end` but never `tool_execution_start`.
 *
 * Every assistant line ends with `(stop=… tokens=… …ms)`, read from the committed assistant message;
 * `duration` is omitted when the message carries none, never printed as 0.
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
  const showText = options.text === "full";
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
  const shown = (text: string) => (showText ? `"${oneLine(text)}"` : `chars=${text.length}`);

  let turnNumber = 0;
  let toolResultsInTurn = 0;
  const startedCalls = new Set<string>();
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
          emit(`user       ${shown(messageText(message))} ${entry}`);
        } else if (message.role === "system") {
          emit(`system     (prompt and tool changes) ${entry}`);
        } else if (message.role === "toolResult") {
          toolResultsInTurn += 1;
          const code = errorDiagnostic(event.entry)?.code;
          emit(
            `toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${code ? ` code=${code}` : ""} ${entry}`,
          );
        } else {
          const text = messageText(message);
          const toolCalls = message.content.filter((block) => block.type === "toolCall");
          const facts =
            `(stop=${message.stopReason} tokens=${message.usage.totalTokens}` +
            `${message.durationMs === undefined ? "" : ` ${Math.round(message.durationMs)}ms`})`;
          if (message.errorMessage) {
            emit(`assistant (${message.stopReason}) ${oneLine(message.errorMessage)} ${entry} ${facts}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) {
              emit(`[Assistant] ${entry} ${facts} ${shown(text)}`);
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
        const failed = result?.role === "toolResult" && result.isError;
        const diagnostic = errorDiagnostic(event.entry);
        if (!startedCalls.delete(event.toolCallId)) {
          // No start was ever emitted for this call: the harness refused it before execution.
          const reason = diagnostic ? ` reason="${oneLine(diagnostic.message)}"` : "";
          emit(`⊘ tool_refused ${event.toolName} call=${event.toolCallId} code=${diagnostic?.code ?? "unknown"}${reason}`);
        } else if (event.entry === undefined) {
          // No entry at all means the tool task faulted or was orphaned — a failure, not a success.
          emit(`◀ tool_end ${event.toolName} call=${event.toolCallId} status=faulted (no result entry)`);
        } else {
          emit(
            `◀ tool_end ${event.toolName} call=${event.toolCallId} status=${failed ? "error" : "success"}${diagnostic ? ` code=${diagnostic.code}` : ""}`,
          );
        }
        break;
      }
      case "auto_retry_start":
        emit(`↻ retry attempt=${event.attempt} ${oneLine(event.errorMessage)}`);
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
    settled: (submissionId, timeoutMs) => tracker.settled(submissionId, timeoutMs, (message) => emit(`trace: ${message}`)),
    async stop() {
      await stream.stop();
    },
  };
}
