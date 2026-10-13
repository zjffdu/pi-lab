import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationRecord, Harness, Storage } from "@earendil-works/pi-durable";

import { listEntries } from "./transcript.js";
import type { Branch } from "./tree-view.js";

/** Every conversation record of the session, root first. `scanConversations` lives on `Storage`, not on `Harness`. */
export async function listConversationRecords(storage: Storage, context: Context): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: Parameters<Storage["scanConversations"]>[2];

  do {
    const page = await storage.scanConversations({ order: "ascending" }, 100, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);

  return records;
}

/** The whole tree: one `Branch` per conversation, each with its fork-aware transcript. */
export async function loadBranches(harness: Harness, storage: Storage, context: Context): Promise<Branch[]> {
  const branches: Branch[] = [];
  for (const record of await listConversationRecords(storage, context)) {
    const conversation = await harness.conversation(record.id, context);
    if (conversation === undefined) {
      throw new Error(`conversation ${record.id} is listed by storage but cannot be opened`);
    }
    branches.push({ record, entries: await listEntries(conversation, context) });
  }
  return branches;
}

/**
 * Going back to an earlier entry and changing the premise is `fork(at)`: a NEW conversation that sees
 * its parent's entries up to and including `at`, and nothing the parent appends afterwards. The parent
 * is not touched. `ownerless` because no task owns this branch — the learner does.
 *
 * `at` must be an entry visible from `parent`; an unknown id, or an entry of an unrelated conversation,
 * is rejected with `Entry <id> is not visible from conversation <parent>`.
 */
export function forkAt(parent: Conversation, at: Parameters<Conversation["fork"]>[0], context: Context): Promise<Conversation> {
  return parent.fork(at, { ownership: { kind: "ownerless" } }, context);
}
