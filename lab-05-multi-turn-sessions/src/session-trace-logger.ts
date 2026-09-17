import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Same shape as Lab 01's trace logger, tagged with a conversation id and
 * closing over one turn counter per agent. Because the counter is created
 * once per `subscribe` call (once per agent, not once per prompt), the turn
 * number keeps climbing across a reused agent's later prompts instead of
 * restarting at #1 — that continuity is itself evidence of session reuse.
 */
export function createSessionTraceLogger(
  conversationId: string,
  write: TraceWriter,
): (event: AgentEvent) => void {
  let turnNumber = 0;

  return (event) => {
    switch (event.type) {
      case "agent_start":
        write(`[Pi][${conversationId}] agent_start`);
        break;
      case "turn_start":
        turnNumber += 1;
        write(`[Pi][${conversationId}] turn_start #${turnNumber}`);
        break;
      case "message_start":
        write(`[Pi][${conversationId}] message_start role=${event.message.role}`);
        break;
      case "message_end": {
        write(`[Pi][${conversationId}] message_end role=${event.message.role}`);
        const text = assistantText(event.message);
        if (text) {
          write(`[Assistant][${conversationId}] ${text}`);
        }
        break;
      }
      case "tool_execution_start":
        write(
          `[Tool][${conversationId}] start ${event.toolName} args=${JSON.stringify(event.args)}`,
        );
        break;
      case "tool_execution_end":
        write(
          `[Tool][${conversationId}] end ${event.toolName} status=${event.isError ? "error" : "success"}`,
        );
        break;
      case "turn_end":
        write(
          `[Pi][${conversationId}] turn_end #${turnNumber} tool_results=${event.toolResults.length}`,
        );
        break;
      case "agent_end":
        write(`[Pi][${conversationId}] agent_end`);
        break;
      case "message_update":
      case "tool_execution_update":
        break;
    }
  };
}
