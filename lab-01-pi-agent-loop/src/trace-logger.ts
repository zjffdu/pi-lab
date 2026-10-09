import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

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
 * Renders the agent's event stream as an indented agent/turn/tool tree instead of one flat
 * `[Pi] ...`-prefixed line per event — `▶`/`◀` mark a span opening and closing, aligned at
 * the same indent (bracket-style), so the nesting is visible at a glance instead of having
 * to be reconstructed mentally from a flat log. Phase 1's `Agent` has no durable session and
 * no recovery concept (that begins with `AgentHarness` in Phase 2 — see Lab 09's version of
 * this file for the `↺` recovery marker this one does not need), so every event this logger
 * sees really happened exactly once, live.
 */
export function createTraceLogger(write: TraceWriter): (event: AgentEvent) => void {
  // Only "agent" and "turn" are genuine LIFO spans: a lab-01 run always has at most one of
  // each open at a time. A tool call is deliberately NOT pushed onto this stack — it is
  // printed as a plain line at the CURRENT depth (a child of whatever turn is open), same as
  // a message line. That matters once a turn can have more than one tool call in flight at
  // once (Lab 04/06 both exercise real parallel tool execution): two overlapping
  // tool_execution_start/end pairs are siblings, not nested inside each other, so treating
  // "tool" as its own push/pop span would either corrupt every indent after a later
  // tool_execution_end pops the wrong entry, or falsely draw one concurrent tool call as
  // "inside" another. A flat, chronologically-ordered list of tool lines — each already
  // self-identifying by its own toolCallId/toolName — is the correct shape for that case,
  // and it degrades to visually identical output for the common single-tool case.
  type Span = "agent" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  const open = (kind: Span, text: string) => {
    write(`${pad()}${text}`);
    stack.push(kind);
  };
  // Pops only if the top of the stack actually matches `kind`; a close with nothing matching
  // to pop still prints at the current depth instead of guessing, so one out-of-order event
  // never throws off every indent after it.
  const close = (kind: Span, text: string) => {
    if (stack[stack.length - 1] === kind) {
      stack.pop();
    }
    write(`${pad()}${text}`);
  };

  let turnNumber = 0;

  return (event) => {
    switch (event.type) {
      case "agent_start":
        open("agent", "▶ agent");
        break;
      case "turn_start":
        turnNumber += 1;
        open("turn", `▶ turn #${turnNumber}`);
        break;
      case "message_end": {
        const message = event.message;
        const prefix = pad();
        if (message.role === "user") {
          write(`${prefix}user       "${textOf(message)}"`);
        } else if (message.role === "toolResult") {
          write(`${prefix}toolResult ${message.toolName} status=${message.isError ? "error" : "success"}`);
        } else if (message.role === "assistant") {
          const text = textOf(message);
          const toolCalls = message.content.filter((block) => block.type === "toolCall");
          if (message.errorMessage) {
            write(`${prefix}assistant (${message.stopReason}) ${message.errorMessage}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) write(`${prefix}[Assistant] ${text}`);
            for (const call of toolCalls) {
              write(`${prefix}assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)}`);
            }
            if (!text && !toolCalls.length) write(`${prefix}assistant (empty)`);
          }
        }
        break;
      }
      case "tool_execution_start":
        write(`${pad()}▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end":
        write(`${pad()}◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
        break;
      case "turn_end":
        close("turn", `◀ turn_end #${turnNumber} tool_results=${event.toolResults.length}`);
        break;
      case "agent_end":
        close("agent", "◀ agent_end");
        break;
      case "message_start":
      case "message_update":
      case "tool_execution_update":
        // Folded into message_end / tool_execution_end respectively — see the file-level
        // comment on the equivalent omission in Lab 09's harness-trace-logger.ts.
        break;
    }
  };
}
