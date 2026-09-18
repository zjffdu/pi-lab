import type { AgentHarness, AgentMessage, HarnessEvent } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

/**
 * Every lane-scoped `HarnessEvent` can carry `recovery?: true` — set when the event is
 * being replayed to observers as part of a harness *catching up* to durable state (for
 * example, during `lane.resume()`) rather than being produced live for the first time.
 */
function isRecovery(event: HarnessEvent): boolean {
  return "recovery" in event && event.recovery === true;
}

function textOf(message: AgentMessage): string {
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
 * Renders `AgentHarness.events` as an indented run/turn/tool tree — `▶`/`◀` mark a span
 * opening and closing, aligned at the same indent (bracket-style); `↺` marks an event fired
 * while the harness is *catching up* to durable state during recovery rather than producing
 * it live. This lab's whole point lives in that marker: the killed process's turn opens
 * live, but everything `lane.resume()` replays afterward — including the synthesized,
 * `isError: true` outcome for the tool call that never got to finish — is tagged `↺`, right
 * down to the exact event where the interruption is visible: a `↺ ◀ tool_end` with no
 * matching `↺ ▶ tool_start` before it, because recovery never re-invoked the tool.
 *
 * Only "run" and "turn" are genuine LIFO spans on the indent stack. A tool call is
 * deliberately NOT pushed onto it — it prints as a plain line at the current depth, same as
 * a message line. That is exactly what keeps the case above from corrupting every indent
 * after it: if "tool" were its own push/pop span, `↺ ◀ tool_end` would have nothing of its
 * own kind to pop and would fall back to popping "turn" instead, throwing off every line for
 * the rest of the resumed operation.
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  _sessionId: string,
  write: TraceWriter,
): () => void {
  type Span = "run" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  const mark = (event: HarnessEvent) => (isRecovery(event) ? "↺ " : "");
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

  const unsubscribers = [
    harness.events.on("run_start", (event) => {
      open("run", `${mark(event)}▶ run ${event.runId}`);
    }),
    harness.events.on("turn_start", (event) => {
      open("turn", `${mark(event)}▶ turn ${event.turnId}`);
    }),
    harness.events.on("tool_start", (event) => {
      write(`${pad()}${mark(event)}▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
    }),
    harness.events.on("tool_end", (event) => {
      write(`${pad()}${mark(event)}◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
    }),
    harness.events.on("message_end", (event) => {
      const message = event.message;
      const prefix = `${pad()}${mark(event)}`;
      const entry = ` entry=${event.entryId ?? "none"}`;
      if (message.role === "user") {
        write(`${prefix}user      "${textOf(message)}"${entry}`);
      } else if (message.role === "toolResult") {
        write(`${prefix}toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${entry}`);
      } else {
        const text = textOf(message);
        write(text ? `${prefix}[Assistant]${entry} ${text}` : `${prefix}assistant (tool call only, no text)${entry}`);
      }
    }),
    harness.events.on("turn_end", (event) => {
      close("turn", `${mark(event)}◀ turn_end tool_results=${event.toolResults.length}`);
    }),
    harness.events.on("run_end", (event) => {
      close("run", `${mark(event)}◀ run_end status=${event.status} fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`);
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
