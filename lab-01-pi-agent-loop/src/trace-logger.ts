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

export function createTraceLogger(write: TraceWriter): (event: AgentEvent) => void {
  let turnNumber = 0;

  return (event) => {
    switch (event.type) {
      case "agent_start":
        write("[Pi] agent_start");
        break;
      case "turn_start":
        turnNumber += 1;
        write(`[Pi] turn_start #${turnNumber}`);
        break;
      case "message_start":
        write(`[Pi] message_start role=${event.message.role}`);
        break;
      case "message_end": {
        write(`[Pi] message_end role=${event.message.role}`);
        const text = assistantText(event.message);
        if (text) {
          write(`[Assistant] ${text}`);
        }
        break;
      }
      case "tool_execution_start":
        write(
          `[Tool] start ${event.toolName} args=${JSON.stringify(event.args)}`,
        );
        break;
      case "tool_execution_end":
        write(
          `[Tool] end ${event.toolName} status=${event.isError ? "error" : "success"}`,
        );
        break;
      case "turn_end":
        write(
          `[Pi] turn_end #${turnNumber} tool_results=${event.toolResults.length}`,
        );
        break;
      case "agent_end":
        write("[Pi] agent_end");
        break;
      case "message_update":
      case "tool_execution_update":
        break;
    }
  };
}
