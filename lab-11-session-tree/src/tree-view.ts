import type { ConversationId, ConversationRecord, EntryId, EntryRecord } from "@earendil-works/pi-durable";

import { summarizeEntry } from "./transcript.js";

/**
 * One branch of the tree is one `Conversation`. Its `entries` are fork-aware: the entries it inherited
 * from its parent up to the fork point — which still carry the *parent's* `conversationId` — followed
 * by the entries it appended itself. That `conversationId` is how this module tells "shared prefix"
 * from "own continuation" without keeping any extra state.
 *
 * There is no movable tip pointer and no branch name in pi-durable. A branch is addressed by its
 * conversation id, and its tip is simply its newest entry. (`head` on an entry is something else: the
 * start of the model's context after a reset or a compaction.)
 */
export interface Branch {
  record: ConversationRecord;
  entries: readonly EntryRecord[];
}

export function ownEntries(branch: Branch): EntryRecord[] {
  return branch.entries.filter((entry) => entry.conversationId === branch.record.id);
}

export function inheritedEntries(branch: Branch): EntryRecord[] {
  return branch.entries.filter((entry) => entry.conversationId !== branch.record.id);
}

/** The newest entry the branch can see; for a fork with no entries of its own, its fork point. */
export function tipOf(branch: Branch): EntryRecord | undefined {
  return branch.entries.at(-1);
}

export interface BranchTip {
  conversationId: ConversationId;
  entryId: EntryId | undefined;
}

/** One tip per branch: the tree has exactly as many tips as conversations. */
export function branchTips(branches: readonly Branch[]): BranchTip[] {
  return branches.map((branch) => ({ conversationId: branch.record.id, entryId: tipOf(branch)?.id }));
}

export function describeFork(record: ConversationRecord): string {
  return record.parent === undefined
    ? `conversation ${record.id} is the root`
    : `conversation ${record.id} forked from conversation ${record.parent.conversationId} at entry ${record.parent.at}`;
}

export interface RenderTreeOptions {
  /** Entry id -> label, from `readLabels()`. */
  labels: ReadonlyMap<string, string>;
  /** The conversation a prompt would go to, if the caller has one in mind. */
  selected?: ConversationId;
}

/**
 * Depth-first text rendering of the whole tree. Each branch prints only its OWN entries, so the shared
 * prefix appears once, under the branch that produced it; a fork is printed right after the entry it
 * forked at, indented one level. `id` and `kind` are always printed verbatim so the diagram can be
 * checked against the raw JSONL by eye.
 */
export function renderTree(branches: readonly Branch[], options: RenderTreeOptions): string {
  const lines: string[] = [];
  const childrenOf = (conversationId: ConversationId, at: EntryId): Branch[] =>
    branches
      .filter((branch) => branch.record.parent?.conversationId === conversationId && branch.record.parent.at === at)
      .toSorted((a, b) => a.record.id - b.record.id);

  function visit(branch: Branch, depth: number): void {
    const indent = "  ".repeat(depth);
    const tip = tipOf(branch);
    const own = ownEntries(branch);
    const parent = branch.record.parent;
    const header =
      parent === undefined
        ? `conversation ${branch.record.id} (root)`
        : `conversation ${branch.record.id} (fork of ${parent.conversationId} @ entry ${parent.at})`;
    const selected = options.selected === branch.record.id ? "  ◀ selected" : "";
    const emptyFork = own.length === 0 && tip !== undefined ? `  [tip: entry ${tip.id}, inherited — no entries of its own yet]` : "";
    lines.push(`${indent}${header}${selected}${emptyFork}`);

    for (const entry of own) {
      const tags = [
        entry.id === tip?.id ? "TIP" : undefined,
        options.labels.has(String(entry.id)) ? `label="${options.labels.get(String(entry.id))}"` : undefined,
      ].filter((tag): tag is string => tag !== undefined);
      lines.push(`${indent}  ${entry.id} ${summarizeEntry(entry)}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""}`);

      for (const child of childrenOf(branch.record.id, entry.id)) {
        visit(child, depth + 2);
      }
    }
  }

  for (const root of branches.filter((branch) => branch.record.parent === undefined)) {
    visit(root, 0);
  }

  return lines.join("\n");
}
