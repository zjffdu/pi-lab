import type { AgentHarness, AgentMessage } from "@earendil-works/pi-agent-core";

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
 * Same lifecycle-logging idea as Lab 01/05/06's trace loggers, adapted to
 * `AgentHarness.events` — a per-harness bus, not a per-agent `subscribe()` callback. Each
 * event carries the durable `lane` name it belongs to, so a multi-lane harness could
 * reuse one logger for every lane; this lab only ever has `"main"`.
 *
 * Registration is one `harness.events.on(type, listener)` call per event type: unlike
 * Lab 01's `Agent.subscribe`, there is no single "every event" entry point, only a
 * type-narrowed one per call.
 */
export function attachHarnessTraceLogger(
  harness: AgentHarness,
  sessionId: string,
  write: TraceWriter,
): () => void {
  const unsubscribers = [
    harness.events.on("lane_created", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} lane_created at=${event.at ?? "null"}`);
    }),
    harness.events.on("run_start", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} run_start run=${event.runId}`);
    }),
    harness.events.on("turn_start", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} turn_start run=${event.runId} turn=${event.turnId}`);
    }),
    harness.events.on("tool_start", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} tool_start tool=${event.toolName} ` +
          `call=${event.toolCallId} args=${JSON.stringify(event.args)}`,
      );
    }),
    harness.events.on("tool_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} tool_end tool=${event.toolName} ` +
          `call=${event.toolCallId} status=${event.isError ? "error" : "success"}`,
      );
    }),
    harness.events.on("message_start", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} message_start role=${event.message.role}`);
    }),
    harness.events.on("message_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} message_end role=${event.message.role} ` +
          `entry=${event.entryId ?? "none"}`,
      );
      const text = assistantText(event.message);
      if (text) {
        write(`[Assistant][${sessionId}] ${text}`);
      }
    }),
    harness.events.on("turn_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} turn_end run=${event.runId} turn=${event.turnId} ` +
          `tool_results=${event.toolResults.length}`,
      );
    }),
    harness.events.on("entry_added", (event) => {
      write(
        `[Entry][${sessionId}] lane=${event.lane} id=${event.entry.id} ` +
          `parent=${event.entry.parentId ?? "null"} seq=${event.entry.seq} type=${event.entry.type}`,
      );
    }),
    harness.events.on("run_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} run_end run=${event.runId} status=${event.status} ` +
          `fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}`,
      );
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
