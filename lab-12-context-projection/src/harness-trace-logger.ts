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
 * aligned at the same indent. Every line keeps an explicit `[sessionId]` tag:
 * `scripts/context-projection-demo.ts` runs two scenarios (no projector, then with one) as
 * separate sessions *within one process*, so their two trace streams land in the same
 * combined stdout one after another — the tag is what tells a reader which scenario a given
 * line belongs to.
 *
 * "run" is the only genuine LIFO span here — this lab never subscribed to
 * `turn_start`/`turn_end` (its focus is durable entries and what reaches the model, not
 * per-turn tool timing), so a tool call nests directly under "run". A tool call itself is
 * still NOT pushed onto the stack — see Lab 09's version of this file for why (crash
 * recovery and parallel tool execution both need tool lines to stay flat siblings, not
 * nested spans).
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  sessionId: string,
  write: TraceWriter,
): () => void {
  type Span = "run";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  const line = (text: string) => write(`[${sessionId}] ${pad()}${text}`);
  const open = (kind: Span, text: string) => {
    line(text);
    stack.push(kind);
  };
  const close = (kind: Span, text: string) => {
    if (stack[stack.length - 1] === kind) {
      stack.pop();
    }
    line(text);
  };

  const unsubscribers = [
    harness.events.on("lane_created", (event) => {
      write(`[${sessionId}] lane "${event.lane}" created`);
    }),
    harness.events.on("run_start", (event) => {
      open("run", `▶ run ${event.runId}`);
    }),
    harness.events.on("tool_start", (event) => {
      line(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
    }),
    harness.events.on("tool_end", (event) => {
      line(`◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
    }),
    harness.events.on("message_end", (event) => {
      const message = event.message;
      const entry = ` entry=${event.entryId ?? "none"}`;
      if (message.role === "user") {
        line(`user      "${textOf(message)}"${entry}`);
      } else if (message.role === "toolResult") {
        line(`toolResult ${message.toolName} status=${message.isError ? "error" : "success"}${entry}`);
      } else {
        const text = textOf(message);
        line(text ? `[Assistant]${entry} ${text}` : `assistant (tool call only, no text)${entry}`);
      }
    }),
    // Only non-message entries are logged here: a message entry's id is already printed on
    // its own message_end line above. A "custom" entry — this lab's own case-note records —
    // has no message_end of its own; this is the only place its landing is ever visible in
    // the live trace, which is also why it is worth printing `customType` for it specifically.
    harness.events.on("entry_added", (event) => {
      if (event.entry.type !== "message") {
        const customType = event.entry.type === "custom" ? ` customType=${event.entry.customType}` : "";
        line(`entry_added id=${event.entry.id} seq=${event.entry.seq} type=${event.entry.type}${customType}`);
      }
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

/**
 * `transform_context` fires once per real provider request with the exact `AgentMessage[]`
 * that request's context will contain — after `buildSessionContext()` has already run every
 * `custom` entry through `entryProjectors` (or, with none registered for its `customType`,
 * dropped it). This is this lab's most direct way to observe *what actually reached the
 * model*: message count, role, and (for a `"custom"`-role message) which durable entry it
 * came from — never the message's own text.
 *
 * Printed as a standalone `[Context][sessionId]` line, not folded into the run/tool tree
 * above: it fires from a separate `harness.hooks` registration (not `harness.events`), on a
 * cadence tied to provider requests rather than to run/tool boundaries, so it does not
 * correspond to any one span on that stack.
 */
export function attachProjectedContextLogger(harness: AgentHarness, sessionId: string, write: TraceWriter): () => void {
  return harness.hooks.on("transform_context", (event) => {
    const roles = event.messages.map((message) => message.role).join(", ");
    const customMessageCount = event.messages.filter((message) => message.role === "custom").length;
    write(
      `[Context][${sessionId}] messages=${event.messages.length} roles=[${roles}] ` +
        `customMessages=${customMessageCount}`,
    );
    return undefined;
  });
}
