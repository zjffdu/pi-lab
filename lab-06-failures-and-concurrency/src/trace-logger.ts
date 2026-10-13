import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TraceWriter = (line: string) => void;

interface ToolTiming {
  toolName: string;
  startElapsedMs: number;
  endElapsedMs?: number;
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

function formatElapsed(ms: number): string {
  return `+${ms.toFixed(2)}ms`;
}

// Every printed line starts with this elapsed time, so its width has to stay
// constant across the whole run — otherwise, as elapsed grows from "+0.00ms"
// to "+5878.13ms", the text after it (including the tree indentation) drifts
// out of column with earlier lines. 11 chars covers up to "+99999.99ms"
// (~100s), far past any run in this lab. Only used for that line-start
// prefix; the inline start=/end= values inside a [Timeline] row stay compact.
function formatElapsedPrefix(ms: number): string {
  return formatElapsed(ms).padStart(11);
}

/**
 * Lab 06's logger folds together everything the earlier labs logged separately: Lab 01's
 * indented agent/turn/tool tree (a tool call is deliberately not its own push/pop span —
 * see Lab 01's version of this file for why that matters specifically for the parallel-tool
 * experiment below), Lab 05's conversation-id tag, and Lab 04's per-turn tool timeline — plus
 * two additions this lab's scope calls for: every line carries a monotonic elapsed time from
 * `performance.now()` (immune to a wall-clock adjustment mid-run, unlike `Date.now()`), and
 * every tool line carries its own `toolCallId`. As in Lab 01, each tool call the model requests
 * prints as its own `assistant (tool call) <name> call=<id> args=<json>` line, so the model's
 * request (and the arguments it chose) is distinguishable from Pi's `tool_start`/`tool_end`
 * execution of it; the `call=` id pairs the two.
 *
 * `performance.now()` is read exactly once per incoming event, at the top of its handler —
 * not once per printed line — so a `turn_end` that emits a `[Timeline]` header plus several
 * detail lines still reports one single, consistent elapsed time for all of them, describing
 * "when this event fired" rather than "when this particular print statement happened to run."
 */
export function createResilienceTraceLogger(
  conversationId: string,
  write: TraceWriter,
): (event: AgentEvent) => void {
  type Span = "agent" | "turn";
  const stack: Span[] = [];
  const pad = () => "  ".repeat(stack.length);
  let turnNumber = 0;
  let startedAt = 0;

  const timings = new Map<string, ToolTiming>();

  return (event) => {
    const elapsedMs = event.type === "agent_start" ? 0 : performance.now() - startedAt;
    const line = (text: string) =>
      write(`[${conversationId}] t=${formatElapsedPrefix(elapsedMs)} turn=${turnNumber} ${pad()}${text}`);
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

    switch (event.type) {
      case "agent_start":
        startedAt = performance.now();
        open("agent", "▶ agent");
        break;
      case "turn_start":
        turnNumber += 1;
        open("turn", "▶ turn");
        break;
      case "message_end": {
        const message = event.message;
        if (message.role === "user") {
          line(`user       "${textOf(message)}"`);
        } else if (message.role === "toolResult") {
          line(`toolResult ${message.toolName} status=${message.isError ? "error" : "success"}`);
        } else if (message.role === "assistant") {
          const text = textOf(message);
          const toolCalls = message.content.filter((block) => block.type === "toolCall");
          if (message.errorMessage) {
            line(`assistant (${message.stopReason}) ${message.errorMessage}`);
          } else {
            // A message can carry text and tool-call requests at once; print both, never one in place of the other.
            if (text) line(`[Assistant] ${text}`);
            for (const call of toolCalls) {
              line(`assistant (tool call) ${call.name} call=${call.id} args=${JSON.stringify(call.arguments)}`);
            }
            if (!text && !toolCalls.length) line("assistant (empty)");
          }
        }
        break;
      }
      case "tool_execution_start":
        timings.set(event.toolCallId, { toolName: event.toolName, startElapsedMs: elapsedMs });
        line(`▶ tool_start ${event.toolName} call=${event.toolCallId} args=${JSON.stringify(event.args)}`);
        break;
      case "tool_execution_end": {
        const timing = timings.get(event.toolCallId);
        if (timing) {
          timing.endElapsedMs = elapsedMs;
        }
        line(`◀ tool_end ${event.toolName} call=${event.toolCallId} status=${event.isError ? "error" : "success"}`);
        break;
      }
      case "turn_end": {
        const sourceOrder =
          event.message.role === "assistant"
            ? event.message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
            : [];

        if (sourceOrder.length > 0) {
          line(`[Timeline] tool_calls=${sourceOrder.length}`);
          for (const toolCallId of sourceOrder) {
            const timing = timings.get(toolCallId);
            const transcriptOrder = event.toolResults.findIndex(
              (result) => result.toolCallId === toolCallId,
            );
            const source = sourceOrder.indexOf(toolCallId);
            const start = timing?.startElapsedMs ?? -1;
            const end = timing?.endElapsedMs ?? -1;
            const duration = timing?.endElapsedMs !== undefined ? end - start : -1;
            line(
              `[Timeline]   id=${toolCallId} ${timing?.toolName ?? "unknown"} source=${source} ` +
                `transcript=${transcriptOrder} start=${formatElapsed(start)} end=${formatElapsed(end)} ` +
                `duration=${duration.toFixed(2)}ms`,
            );
          }
        }

        close("turn", `◀ turn_end tool_results=${event.toolResults.length}`);
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
