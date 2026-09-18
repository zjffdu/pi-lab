import type { AgentHarness, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

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
 * Renders `AgentHarness.events` as an indented run/turn/tool tree instead of one flat
 * `[Harness][sessionId] ...` line per event — `▶`/`◀` mark a span opening and closing,
 * aligned at the same indent (bracket-style). Same idea as Lab 01's `Agent`-level logger,
 * adapted to `harness.events.on(type, listener)` — a per-harness bus with one registration
 * per event type, rather than a single `Agent.subscribe()` entry point.
 *
 * Only "run" and "turn" are genuine LIFO spans — a lane never has more than one of each
 * open at a time. A tool call is deliberately NOT pushed onto this stack; it prints as a
 * plain line at the current depth, same as a message line. This lab's own tool
 * (`get_booking`) is always sequential and never interrupted, so the difference is
 * invisible here — but see Lab 09's version of this file for the two real scenarios (crash
 * recovery, parallel tool execution) where treating "tool" as its own push/pop span would
 * silently corrupt every indent after it.
 *
 * `message_start` and `entry_added` are intentionally not subscribed to here: every fact
 * they would add (role, entryId) is already folded into the corresponding `message_end`
 * line — this lab has no non-message entry type (that begins with compaction in Lab 10),
 * so there is nothing `entry_added` alone would ever reveal.
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  _sessionId: string,
  write: TraceWriter,
): () => void {
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

  const unsubscribers = [
    harness.events.on("lane_created", (event) => {
      write(`${pad()}lane "${event.lane}" created`);
    }),
    harness.events.on("run_start", (event) => {
      open("run", `▶ run ${event.runId}`);
    }),
    harness.events.on("turn_start", (event) => {
      open("turn", `▶ turn ${event.turnId}`);
    }),
    harness.events.on("tool_start", (event) => {
      write(`${pad()}▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
    }),
    harness.events.on("tool_end", (event) => {
      write(`${pad()}◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
    }),
    harness.events.on("message_end", (event) => {
      const message = event.message;
      const prefix = pad();
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
      close("turn", `◀ turn_end tool_results=${event.toolResults.length}`);
    }),
    harness.events.on("run_end", (event) => {
      close("run", `◀ run_end status=${event.status} fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`);
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
