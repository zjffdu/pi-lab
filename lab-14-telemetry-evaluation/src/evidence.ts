import type { EntryRecord } from "@earendil-works/pi-durable";

import type { ToolCallRecord } from "./deterministic-checks.js";
import { messageText } from "./transcript.js";

/**
 * Tool calls reconstructed from the DURABLE transcript, not from a live listener: every `toolCall` block an
 * assistant entry requested, paired with the `toolResult` entry that answers its `call.id`. This is the same
 * evidence a restart, an auditor, or a later lab would read — and it needs no second event stream.
 *
 * A request with no `toolResult` entry (the task faulted or was orphaned) is reported `isError: true` with an
 * empty `resultText`: a call that produced no result is never evidence of anything.
 */
export function toolCallsFromEntries(entries: readonly EntryRecord[]): ToolCallRecord[] {
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (message?.role === "toolResult") {
      results.set(message.toolCallId, { isError: message.isError, text: messageText(message) });
    }
  }

  const calls: ToolCallRecord[] = [];
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (message?.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      calls.push({
        toolName: block.name,
        toolCallId: block.id,
        args: block.arguments as Record<string, unknown>,
        isError: result === undefined ? true : result.isError,
        resultText: result?.text ?? "",
      });
    }
  }
  return calls;
}

/** Text of the assistant entry a `done` submission reports as its answer; "" for any other outcome. */
export function answerTextOf(entries: readonly EntryRecord[], answerEntryId: number | undefined): string {
  if (answerEntryId === undefined) return "";
  const message = entries.find((entry) => entry.id === answerEntryId)?.model?.[0];
  return message?.role === "assistant" ? messageText(message) : "";
}
