import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord, ToolDiagnostic } from "@earendil-works/pi-durable";

/**
 * Every entry the conversation can see, oldest first. `entries()` is paged and defaults to newest
 * first, so the order and the loop are explicit.
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

/**
 * The structured diagnostics the harness stored on a `pi.tool-result` entry, or `[]` for any other
 * entry. Each carries a machine-readable `code` — `blocked`, `tool_unavailable`, `invalid_arguments`,
 * `tool_error`, `interrupted`, `aborted` — which is what tells apart the ways a tool call can end in
 * an error result. The flag `isError` alone cannot.
 */
export function entryDiagnostics(entry: Pick<EntryRecord, "data"> | undefined): ToolDiagnostic[] {
  const data = entry?.data;
  if (typeof data !== "object" || data === null || !("diagnostics" in data)) {
    return [];
  }
  const diagnostics = (data as { diagnostics: unknown }).diagnostics;
  return Array.isArray(diagnostics) ? (diagnostics as ToolDiagnostic[]) : [];
}

/** The first error diagnostic of a tool-result entry, if it has one. */
export function errorDiagnostic(entry: Pick<EntryRecord, "data"> | undefined): ToolDiagnostic | undefined {
  return entryDiagnostics(entry).find((diagnostic) => diagnostic.severity === "error");
}

/**
 * One short line describing an entry: its kind and, when it has one, the model message it carries. A
 * tool result shows its status and, for an error, the diagnostic code that says *why* it is an error.
 */
export function describeEntry(entry: EntryRecord, maxText = 56): string {
  const message = entry.model?.[0];
  if (!message) {
    return entry.kind;
  }
  const flat = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > maxText ? `${one.slice(0, maxText - 1)}…` : one;
  };
  if (message.role === "assistant") {
    const calls = message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
    const text = flat(messageText(message));
    return `${entry.kind}${text ? ` "${text}"` : ""}${calls.length > 0 ? ` (tool call: ${calls.join(", ")})` : ""}`;
  }
  if (message.role === "toolResult") {
    const code = errorDiagnostic(entry)?.code;
    return `${entry.kind} ${message.toolName} status=${message.isError ? "error" : "success"}${code ? ` code=${code}` : ""}`;
  }
  if (message.role === "user") {
    return `${entry.kind} "${flat(messageText(message))}"`;
  }
  return entry.kind;
}
