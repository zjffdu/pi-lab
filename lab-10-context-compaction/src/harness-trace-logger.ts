import { estimateContextTokens, type AgentHarness, type AgentMessage } from "@earendil-works/pi-agent-core";

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
 * aligned at the same indent. Unlike Lab 07-09's version of this file, every line here keeps
 * an explicit `[sessionId]` tag: `scripts/compaction-demo.ts` runs more than one scenario
 * (default settings, then custom `compactionInstructions`) as separate sessions *within one
 * process*, so their two trace streams land in the same combined stdout one after another —
 * the tag is what tells a reader which scenario a given line belongs to.
 *
 * "run" and "compaction" are both genuine LIFO spans, and siblings of each other, not nested
 * inside one another: `lane.compact()` starts its own operation (`kind: "compaction"`),
 * separate from any `run` — see the roadmap's "Open operation" vocabulary in Lab 07/08's
 * README. "turn" nests inside "run" as usual. A tool call is deliberately NOT pushed onto
 * this stack — see Lab 09's version of this file for why (crash recovery and parallel tool
 * execution both need tool lines to stay flat siblings, not nested spans).
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  sessionId: string,
  write: TraceWriter,
): () => void {
  type Span = "run" | "turn" | "compaction";
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
    harness.events.on("turn_start", (event) => {
      open("turn", `▶ turn ${event.turnId}`);
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
    harness.events.on("turn_end", (event) => {
      close("turn", `◀ turn_end tool_results=${event.toolResults.length}`);
    }),
    // Only non-message entries are logged here: a message entry's id is already printed on
    // its own message_end line above, so repeating it would add nothing. A "compaction"
    // entry (the durable summary `lane.compact()` produces) has no message_end of its own —
    // this is the only place its landing is ever visible in the live trace.
    harness.events.on("entry_added", (event) => {
      if (event.entry.type !== "message") {
        line(`entry_added id=${event.entry.id} seq=${event.entry.seq} type=${event.entry.type}`);
      }
    }),
    harness.events.on("run_end", (event) => {
      close("run", `◀ run_end status=${event.status} fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`);
    }),
    harness.events.on("compaction_start", (event) => {
      open("compaction", `▶ compaction reason=${event.reason}`);
    }),
    harness.events.on("compaction_end", (event) => {
      close(
        "compaction",
        `◀ compaction_end status=${event.status}` + (event.status === "completed" ? ` entry=${event.entryId}` : ""),
      );
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
 * about to become that request's context — after any prior compaction entry has already been
 * reconstructed into a leading `compactionSummary` message plus its retained tail. This is
 * the most direct way to observe "how many tokens does the *next* request actually carry" —
 * measured with the same `estimateContextTokens` heuristic the harness itself uses to decide
 * whether to compact, not a bespoke one this lab invents.
 *
 * Printed as a standalone `[Context][sessionId]` line, not folded into the run/turn/tool
 * tree above: it fires from a separate `harness.hooks` registration (not `harness.events`),
 * on a cadence tied to provider requests rather than to turn/tool boundaries, so it does not
 * correspond to any one span on that stack.
 */
export function attachContextTokenHook(harness: AgentHarness, sessionId: string, write: TraceWriter): () => void {
  return harness.hooks.on("transform_context", (event) => {
    const estimate = estimateContextTokens(event.messages);
    write(
      `[Context][${sessionId}] messages=${event.messages.length} estimatedTokens=${estimate.tokens} ` +
        `(usageTokens=${estimate.usageTokens} trailingTokens=${estimate.trailingTokens})`,
    );
    return undefined;
  });
}
