import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

interface ToolTiming {
  toolName: string;
  startElapsedMs: number;
  endElapsedMs?: number;
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

function formatElapsed(ms: number): string {
  return `+${ms.toFixed(2)}ms`;
}

/**
 * Lab 06's trace logger folds together everything the earlier labs logged
 * separately: Lab 05's conversation id tag, Lab 04's per-turn tool timeline,
 * and two additions this lab's scope calls for — every tool line now carries
 * its `toolCallId`, and every elapsed time comes from `performance.now()`
 * rather than `Date.now()`. `performance.now()` is monotonic: it cannot go
 * backwards or jump if the system wall clock is adjusted mid-run, which
 * matters once a run can last long enough (an artificially slow tool, a
 * queued follow-up) for that to be a real risk.
 */
export function createResilienceTraceLogger(
  conversationId: string,
  write: TraceWriter,
): (event: AgentEvent) => void {
  let turnNumber = 0;
  let startedAt = 0;
  const timings = new Map<string, ToolTiming>();

  const elapsed = (): number => performance.now() - startedAt;

  return (event) => {
    switch (event.type) {
      case "agent_start":
        startedAt = performance.now();
        write(`[Pi][${conversationId}] t=${formatElapsed(0)} turn=${turnNumber} agent_start`);
        break;
      case "turn_start":
        turnNumber += 1;
        write(`[Pi][${conversationId}] t=${formatElapsed(elapsed())} turn=${turnNumber} turn_start`);
        break;
      case "message_start":
        write(
          `[Pi][${conversationId}] t=${formatElapsed(elapsed())} turn=${turnNumber} ` +
            `message_start role=${event.message.role}`,
        );
        break;
      case "message_end": {
        write(
          `[Pi][${conversationId}] t=${formatElapsed(elapsed())} turn=${turnNumber} ` +
            `message_end role=${event.message.role}`,
        );
        const text = assistantText(event.message);
        if (text) {
          write(`[Assistant][${conversationId}] ${text}`);
        }
        break;
      }
      case "tool_execution_start": {
        const elapsedMs = elapsed();
        timings.set(event.toolCallId, { toolName: event.toolName, startElapsedMs: elapsedMs });
        write(
          `[Tool][${conversationId}] t=${formatElapsed(elapsedMs)} turn=${turnNumber} ` +
            `id=${event.toolCallId} start ${event.toolName} args=${JSON.stringify(event.args)}`,
        );
        break;
      }
      case "tool_execution_end": {
        const elapsedMs = elapsed();
        const timing = timings.get(event.toolCallId);
        if (timing) {
          timing.endElapsedMs = elapsedMs;
        }
        write(
          `[Tool][${conversationId}] t=${formatElapsed(elapsedMs)} turn=${turnNumber} ` +
            `id=${event.toolCallId} end ${event.toolName} status=${event.isError ? "error" : "success"}`,
        );
        break;
      }
      case "turn_end": {
        const sourceOrder =
          event.message.role === "assistant"
            ? event.message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
            : [];

        if (sourceOrder.length > 0) {
          write(`[Timeline][${conversationId}] turn=${turnNumber} tool_calls=${sourceOrder.length}`);
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
              `[Timeline][${conversationId}]   id=${toolCallId} ${timing?.toolName ?? "unknown"} ` +
                `source=${source} transcript=${transcriptOrder} start=${formatElapsed(start)} ` +
                `end=${formatElapsed(end)} duration=${duration.toFixed(2)}ms`,
            );
          }
        }

        write(
          `[Pi][${conversationId}] t=${formatElapsed(elapsed())} turn=${turnNumber} ` +
            `turn_end tool_results=${event.toolResults.length}`,
        );
        break;
      }
      case "agent_end":
        write(`[Pi][${conversationId}] t=${formatElapsed(elapsed())} turn=${turnNumber} agent_end`);
        break;
      case "message_update":
      case "tool_execution_update":
        break;
    }
  };
}
