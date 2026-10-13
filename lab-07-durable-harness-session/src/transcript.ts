import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

/**
 * Every committed entry of the conversation, oldest first. `entries()` is paged and
 * defaults to newest first, so the order and the paging loop both have to be explicit.
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

export function describeEntry(entry: EntryRecord): string {
  const role = entry.model?.[0]?.role;
  return `id=${entry.id} kind=${entry.kind}${role ? ` role=${role}` : ""}`;
}
