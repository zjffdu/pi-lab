import type { AgentHarness, AgentMessage, HarnessEvent } from "@earendil-works/pi-agent-core";

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
 * Every lane-scoped `HarnessEvent` can carry `recovery?: true` — set when the event is
 * being replayed to observers as part of a harness *catching up* to durable state (for
 * example, during `lane.resume()`) rather than being produced live for the first time.
 * This lab reuses Lab 08's logger unchanged: the interesting new contrast is not in this
 * file, it is in whether `tool_start`/`tool_end` fire a *second* time on resume (the safe
 * tool) or fire only once with a synthesized error (the never-replay tool) — both visible
 * here without this logger knowing anything about replay policy at all.
 */
function recoveryTag(event: HarnessEvent): string {
  return "recovery" in event && event.recovery ? " recovery=true" : "";
}

export function attachHarnessTraceLogger(
  harness: AgentHarness,
  sessionId: string,
  write: TraceWriter,
): () => void {
  const unsubscribers = [
    harness.events.on("lane_created", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} lane_created at=${event.at ?? "null"}${recoveryTag(event)}`);
    }),
    harness.events.on("run_start", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} run_start run=${event.runId}${recoveryTag(event)}`);
    }),
    harness.events.on("run_resume", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} run_resume run=${event.runId}${recoveryTag(event)}`);
    }),
    harness.events.on("turn_start", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} turn_start run=${event.runId} turn=${event.turnId}${recoveryTag(event)}`,
      );
    }),
    harness.events.on("tool_start", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} tool_start tool=${event.toolName} ` +
          `call=${event.toolCallId} args=${JSON.stringify(event.args)}${recoveryTag(event)}`,
      );
    }),
    harness.events.on("tool_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} tool_end tool=${event.toolName} ` +
          `call=${event.toolCallId} status=${event.isError ? "error" : "success"}${recoveryTag(event)}`,
      );
    }),
    harness.events.on("message_start", (event) => {
      write(`[Harness][${sessionId}] lane=${event.lane} message_start role=${event.message.role}${recoveryTag(event)}`);
    }),
    harness.events.on("message_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} message_end role=${event.message.role} ` +
          `entry=${event.entryId ?? "none"}${recoveryTag(event)}`,
      );
      const text = assistantText(event.message);
      if (text) {
        write(`[Assistant][${sessionId}] ${text}`);
      }
    }),
    harness.events.on("turn_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} turn_end run=${event.runId} turn=${event.turnId} ` +
          `tool_results=${event.toolResults.length}${recoveryTag(event)}`,
      );
    }),
    harness.events.on("entry_added", (event) => {
      write(
        `[Entry][${sessionId}] lane=${event.lane} id=${event.entry.id} ` +
          `parent=${event.entry.parentId ?? "null"} seq=${event.entry.seq} type=${event.entry.type}${recoveryTag(event)}`,
      );
    }),
    harness.events.on("run_end", (event) => {
      write(
        `[Harness][${sessionId}] lane=${event.lane} run_end run=${event.runId} status=${event.status} ` +
          `fromTip=${event.fromTipId ?? "null"} tip=${event.tipId ?? "null"}${recoveryTag(event)}`,
      );
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
