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
  type Span = "agent" | "turn" | "tool";
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
          if (message.errorMessage) {
            write(`${prefix}assistant (${message.stopReason}) ${message.errorMessage}`);
          } else if (text) {
            write(`${prefix}[Assistant] ${text}`);
          } else {
            const toolCalls = message.content.filter((block) => block.type === "toolCall");
            write(
              toolCalls.length
                ? `${prefix}assistant (tool calls: ${toolCalls.map((call) => call.name).join(", ")})`
                : `${prefix}assistant (empty)`,
            );
          }
        }
        break;
      }
      case "tool_execution_start":
        open("tool", `▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end":
        close("tool", `◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
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
