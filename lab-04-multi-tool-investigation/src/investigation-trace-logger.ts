import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

interface ToolTiming {
  toolName: string;
  args: unknown;
  startElapsedMs: number;
  endElapsedMs?: number;
  isError?: boolean;
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
 * Extends Lab 01's indented agent/turn/tool tree with a per-turn timeline: for every tool
 * call resolved in that turn, its source order (position in the assistant message),
 * transcript order (position in turn_end.toolResults), start/end time relative to
 * agent_start, and duration. Source and transcript order can diverge from completion order
 * under parallel tool execution — which is exactly why tool lines print as a flat,
 * chronologically-ordered list at the turn's own child depth rather than as their own
 * push/pop span (see Lab 01's version of this file for the full reasoning): two overlapping
 * tool calls are siblings, not nested inside each other, and the `[Timeline]` block below is
 * what actually reconstructs their real relationship, not the indentation.
 */
export function createInvestigationTraceLogger(write: TraceWriter): (event: AgentEvent) => void {
  type Span = "agent" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
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

  let turnNumber = 0;
  let agentStartedAt = 0;
  const timings = new Map<string, ToolTiming>();

  return (event) => {
    switch (event.type) {
      case "agent_start":
        agentStartedAt = Date.now();
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
        timings.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          startElapsedMs: Date.now() - agentStartedAt,
        });
        write(`${pad()}▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        const timing = timings.get(event.toolCallId);
        if (timing) {
          timing.endElapsedMs = Date.now() - agentStartedAt;
          timing.isError = event.isError;
        }
        write(`${pad()}◀ tool_end ${event.toolName} status=${event.isError ? "error" : "success"}`);
        break;
      }
      case "turn_end": {
        const sourceOrder =
          event.message.role === "assistant"
            ? event.message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
            : [];

        if (sourceOrder.length > 0) {
          write(`${pad()}[Timeline] tool_calls=${sourceOrder.length}`);
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
              `${pad()}[Timeline]   ${timing?.toolName ?? "unknown"} source=${source} transcript=${transcriptOrder} ` +
                `start=+${start}ms end=+${end}ms duration=${duration}ms`,
            );
          }
        }

        close("turn", `◀ turn_end #${turnNumber} tool_results=${event.toolResults.length}`);
        break;
      }
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
