import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

/**
 * Every entry the conversation can see, oldest first. `entries()` is fork-aware: for a fork it returns
 * the parent's entries up to the fork point (still carrying the parent's `conversationId`) followed by
 * the fork's own. It is paged and defaults to newest first, so the order and the loop are explicit.
 */
export async function listEntries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];

  do {
    const page = await conversation.entries({ order: "ascending" }, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);

  return entries;
}

export function messageText(message: Message): string {
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

/** Plain text of an entry's first model message, or "" for an entry that carries none. */
export function entryText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  return message ? messageText(message) : "";
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One short line describing an entry: what role it plays and, when it has any, its text. */
export function summarizeEntry(entry: EntryRecord, maxText = 56): string {
  const message = entry.model?.[0];
  if (!message) {
    return entry.kind;
  }
  if (message.role === "assistant") {
    const text = truncate(messageText(message), maxText);
    const calls = message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
    if (calls.length > 0) {
      return `${entry.kind} ${text ? `"${text}" ` : ""}(tool call: ${calls.join(", ")})`;
    }
    return `${entry.kind} "${text}"`;
  }
  if (message.role === "toolResult") {
    return `${entry.kind} ${message.toolName}`;
  }
  if (message.role === "user") {
    return `${entry.kind} "${truncate(messageText(message), maxText)}"`;
  }
  return entry.kind;
}
