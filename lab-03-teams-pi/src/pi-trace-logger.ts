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
 * Same lifecycle shape as Lab 01's trace-logger, prefixed with the request ID
 * that ties this Pi run back to the Teams activity that started it.
 */
export function createPiTraceLogger(
  requestId: string,
  write: TraceWriter,
): (event: AgentEvent) => void {
  let turnNumber = 0;
  const prefix = `[Pi][req:${requestId}]`;

  return (event) => {
    switch (event.type) {
      case "agent_start":
        write(`${prefix} agent_start`);
        break;
      case "turn_start":
        turnNumber += 1;
        write(`${prefix} turn_start #${turnNumber}`);
        break;
      case "message_start":
        write(`${prefix} message_start role=${event.message.role}`);
        break;
      case "message_end": {
        write(`${prefix} message_end role=${event.message.role}`);
        const text = assistantText(event.message);
        if (text) {
          write(`${prefix} assistant_text ${text}`);
        }
        break;
      }
      case "tool_execution_start":
        write(`${prefix} tool_start ${event.toolName} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end":
        write(`${prefix} tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
        break;
      case "turn_end":
        write(`${prefix} turn_end #${turnNumber} tool_results=${event.toolResults.length}`);
        break;
      case "agent_end":
        write(`${prefix} agent_end`);
        break;
      case "message_update":
      case "tool_execution_update":
        break;
    }
  };
}
