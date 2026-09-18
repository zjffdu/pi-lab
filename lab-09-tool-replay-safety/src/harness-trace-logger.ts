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
 * Unlike Lab 08's flat one-line-per-event logger, this one renders the event stream as an
 * indented run/turn/tool tree — `▶`/`◀` mark a span opening and closing, `↺` marks an event
 * fired while the harness is catching up to durable state rather than producing it live.
 * The tree shape *is* the evidence this lab cares about: whether a `▶ tool_start` reappears
 * during recovery (the safe tool does) or the span jumps straight from `effect_pending` to a
 * synthesized `◀ tool_end` with no matching `▶` (the never tool does) is easier to see in the
 * shape of the log than in a `recovery=true` suffix buried in a flat line.
 *
 * `message_start` and `entry_added` are intentionally not subscribed to here: every fact they
 * would add (role, entryId) is already folded into the corresponding `message_end` line, and
 * `cli.ts`'s own before/after entry dump is the authoritative seq/parent listing for evidence
 * purposes — this logger's job is a readable live trace, not a second copy of that dump.
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  _sessionId: string,
  write: TraceWriter,
): () => void {
  // Bracket-matching indent: an opening span prints at the CURRENT depth and then pushes
  // itself onto the stack; a closing span pops first (only if it actually matches what is
  // on top) and prints at the resulting depth — so `▶ run`/`▶ turn` and their `◀ ..._end`
  // line up at the same indent, with everything in between one level deeper.
  //
  // Only "run" and "turn" are genuine LIFO spans. A tool call is deliberately NOT pushed
  // onto this stack — it prints as a plain line at the CURRENT depth, same as a message
  // line. Two reasons, both load-bearing:
  //   1. The never-replay recovery path jumps straight from `▶ turn` to a synthesized
  //      `◀ tool_end` with no `▶ tool_start` in between (see the safe/never contrast in
  //      this lab's README) — there would be no "tool" span on the stack to pop.
  //   2. A tool declared `executionMode: "parallel"` can have two calls genuinely
  //      overlapping (start A, start B, end A, end B) — treating "tool" as its own
  //      push/pop span would pop the wrong entry on `end A` and throw off every indent
  //      after it. This lab's own tools are sequential, but the logger is shared code with
  //      every other lab, several of which do exercise real parallel tool execution.
  // A flat, chronologically-ordered list of tool lines — each already self-identifying by
  // its own toolCallId/toolName — is the correct shape for all three cases, and it is
  // visually identical to a bracket for the common single, non-overlapping tool call.
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

  const writeBlock = (prefix: string, text: string) => {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      write(prefix.trimEnd());
      return;
    }
    write(`${prefix}${lines[0]}`);
    for (const continued of lines.slice(1)) {
      write(`${pad()}    ${continued}`);
    }
  };

  const unsubscribers = [
    harness.events.on("run_start", (event) => {
      open("run", `${mark(event)}▶ run ${event.runId}`);
    }),
    harness.events.on("run_resume", (event) => {
      write(`${pad()}${mark(event)}↻ run resumed ${event.runId}`);
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
        if (text) {
          // Kept as a literal "[Assistant]" tag (not just tree styling) because it is also
          // this lab's plain-text answer marker — scripts/replay-safety-demo.ts greps for it.
          writeBlock(`${prefix}[Assistant]${entry} `, text);
        } else {
          write(`${prefix}assistant (tool call only, no text)${entry}`);
        }
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
