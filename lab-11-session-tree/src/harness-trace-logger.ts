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
 * Renders `harness.events` as an indented tree — `▶`/`◀` mark a span opening/closing,
 * aligned at the same indent. "run" and "navigation" are both genuine LIFO spans and
 * siblings of each other, not nested inside one another: `lane.navigateTree()` starts its
 * own operation (`kind: "navigation"`), separate from any `run`. There is no "turn" span
 * here — this lab never subscribed to `turn_start`/`turn_end` (its focus is entries and
 * branch structure, not per-turn tool timing), so a tool call nests directly under whichever
 * of "run"/"navigation" is open. A tool call itself is still NOT pushed onto the stack — see
 * Lab 09's version of this file for why (crash recovery and parallel tool execution both
 * need tool lines to stay flat siblings, not nested spans).
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  _sessionId: string,
  write: TraceWriter,
): () => void {
  type Span = "run" | "navigation";
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
      write(`lane "${event.lane}" created`);
    }),
    harness.events.on("run_start", (event) => {
      open("run", `▶ run ${event.runId}`);
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
    // Only non-message entries are logged here: a message entry's id is already printed on
    // its own message_end line above. A "branch_summary" entry (the durable summary a
    // summarized `navigateTree()` produces) has no message_end of its own — this is the only
    // place its landing is ever visible in the live trace.
    harness.events.on("entry_added", (event) => {
      if (event.entry.type !== "message") {
        write(`${pad()}entry_added id=${event.entry.id} parent=${event.entry.parentId ?? "null"} seq=${event.entry.seq} type=${event.entry.type}`);
      }
    }),
    harness.events.on("run_end", (event) => {
      close("run", `◀ run_end status=${event.status} fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`);
    }),
    harness.events.on("navigation_start", (event) => {
      open("navigation", `▶ navigation target=${event.targetId ?? "null"}`);
    }),
    harness.events.on("navigation_end", (event) => {
      close(
        "navigation",
        `◀ navigation_end status=${event.status} fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`,
      );
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
