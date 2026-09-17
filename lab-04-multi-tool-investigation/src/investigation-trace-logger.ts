import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

interface ToolTiming {
  toolName: string;
  args: unknown;
  startElapsedMs: number;
  endElapsedMs?: number;
  isError?: boolean;
}

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
 * Extends the Lab 01 lifecycle trace with a per-turn timeline: for every tool
 * call resolved in that turn, its source order (position in the assistant
 * message), transcript order (position in turn_end.toolResults), start/end
 * time relative to agent_start, and duration. Source and transcript order can
 * diverge from completion order under parallel tool execution.
 */
export function createInvestigationTraceLogger(write: TraceWriter): (event: AgentEvent) => void {
  let turnNumber = 0;
  let agentStartedAt = 0;
  const timings = new Map<string, ToolTiming>();

  return (event) => {
    switch (event.type) {
      case "agent_start":
        agentStartedAt = Date.now();
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
        timings.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          startElapsedMs: Date.now() - agentStartedAt,
        });
        write(`[Tool] start ${event.toolName} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        const timing = timings.get(event.toolCallId);
        if (timing) {
          timing.endElapsedMs = Date.now() - agentStartedAt;
          timing.isError = event.isError;
        }
        write(`[Tool] end ${event.toolName} status=${event.isError ? "error" : "success"}`);
        break;
      }
      case "turn_end": {
        const sourceOrder =
          event.message.role === "assistant"
            ? event.message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
            : [];

        if (sourceOrder.length > 0) {
          write(`[Timeline] turn #${turnNumber} tool_calls=${sourceOrder.length}`);
          for (const toolCallId of sourceOrder) {
            const timing = timings.get(toolCallId);
            const transcriptOrder = event.toolResults.findIndex(
              (result) => result.toolCallId === toolCallId,
            );
            const source = sourceOrder.indexOf(toolCallId);
            const start = timing?.startElapsedMs ?? -1;
            const end = timing?.endElapsedMs ?? -1;
            const duration = timing?.endElapsedMs !== undefined ? end - start : -1;
            write(
              `[Timeline]   ${timing?.toolName ?? "unknown"} source=${source} transcript=${transcriptOrder} ` +
                `start=+${start}ms end=+${end}ms duration=${duration}ms`,
            );
          }
        }

        write(`[Pi] turn_end #${turnNumber} tool_results=${event.toolResults.length}`);
        break;
      }
      case "agent_end":
        write("[Pi] agent_end");
        break;
      case "message_update":
      case "tool_execution_update":
        break;
    }
  };
}
