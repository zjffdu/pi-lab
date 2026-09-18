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
 * Same indented agent/turn/tool tree as Lab 01's trace logger — see that file for why a tool
 * call is deliberately not its own push/pop span — with every line still tagged
 * `[conversationId]`. Unlike Lab 01/07-09's version of this file, that tag is not
 * optional noise here: it is closed over once per `createSessionAgent`/`subscribe` call (once
 * per agent, not once per prompt), and the turn counter keeps climbing across a reused
 * agent's later prompts instead of restarting at #1 — that continuity, made legible by the
 * shared tag across every line from both prompts, is itself the evidence this lab's scope
 * asks for: that a later CLI invocation resumed the *same* in-memory agent instead of
 * silently creating a new one.
 */
export function createSessionTraceLogger(
  conversationId: string,
  write: TraceWriter,
): (event: AgentEvent) => void {
  type Span = "agent" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  const line = (text: string) => write(`[${conversationId}] ${pad()}${text}`);
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
        if (message.role === "user") {
          line(`user       "${textOf(message)}"`);
        } else if (message.role === "toolResult") {
          line(`toolResult ${message.toolName} status=${message.isError ? "error" : "success"}`);
        } else if (message.role === "assistant") {
          const text = textOf(message);
          if (message.errorMessage) {
            line(`assistant (${message.stopReason}) ${message.errorMessage}`);
          } else if (text) {
            line(`[Assistant] ${text}`);
          } else {
            const toolCalls = message.content.filter((block) => block.type === "toolCall");
            line(
              toolCalls.length
                ? `assistant (tool calls: ${toolCalls.map((call) => call.name).join(", ")})`
                : "assistant (empty)",
            );
          }
        }
        break;
      }
      case "tool_execution_start":
        line(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end":
        line(`◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
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
        break;
    }
  };
}
