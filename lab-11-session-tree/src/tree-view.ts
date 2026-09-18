import type { Entry } from "@earendil-works/pi-agent-core";

/**
 * `AgentLane.findEntries()` defaults its `start` to the lane's own current tip and walks
 * backward — it can only ever show one branch's ancestry. `Session.findEntries()` (no lane
 * involved) scans every entry the storage backend has ever written, across every branch, in
 * one call — see `StorageBackedSession.findEntries` in
 * `node_modules/@earendil-works/pi-agent-core/dist/harness/session/session.js`. That whole-tree
 * view is what this module works with: nothing here calls `AgentLane.findEntries()`.
 */

/**
 * A branch tip is a leaf: an entry id that no other entry names as its `parentId`. There is no
 * dedicated "list every tip" API — `navigateTree()` only ever moves one lane's own tip pointer
 * — so this is computed directly from the whole-tree entry set, the same way this lab's README
 * derives it by hand.
 */
export function findBranchTips(entries: readonly Entry[]): string[] {
  const parentIds = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => id !== null));
  return entries.filter((entry) => !parentIds.has(entry.id)).map((entry) => entry.id);
}

export function childrenOf(entries: readonly Entry[], parentId: string | null): Entry[] {
  return entries.filter((entry) => entry.parentId === parentId);
}

function entrySummary(entry: Entry): string {
  if (entry.type === "message") {
    if (entry.message.role === "user") {
      const text = typeof entry.message.content === "string" ? entry.message.content : "";
      return `user: ${text.slice(0, 60)}`;
    }
    if (entry.message.role === "assistant") {
      const text = entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      return `assistant: ${text.slice(0, 60)}`;
    }
    return entry.message.role;
  }
  if (entry.type === "branch_summary") {
    return `branch_summary (fromId=${entry.fromId ?? "null"}): ${entry.summary.slice(0, 60)}`;
  }
  if (entry.type === "compaction") {
    return `compaction: ${entry.summary.slice(0, 60)}`;
  }
  return `custom:${entry.customType}`;
}

export interface RenderTreeOptions {
  labels: ReadonlyMap<string, string>;
  activeTipId: string | null;
}

/**
 * Depth-first, root(s)-first text rendering of the whole entry set, one line per entry, with
 * `seq`/`id`/`parentId` always printed verbatim so the diagram can be checked against raw
 * `session-data/*.jsonl` by eye. Branch points (an entry with more than one child) render each
 * child on its own indented line — this is the "before/after tree diagram" the README's
 * evidence section is built from.
 */
export function renderTree(entries: readonly Entry[], options: RenderTreeOptions): string {
  const tips = new Set(findBranchTips(entries));
  const lines: string[] = [];

  function visit(entry: Entry, depth: number): void {
    const indent = "  ".repeat(depth);
    const label = options.labels.get(entry.id);
    const tags = [
      tips.has(entry.id) ? "TIP" : undefined,
      entry.id === options.activeTipId ? "ACTIVE" : undefined,
      label ? `label="${label}"` : undefined,
    ].filter((tag): tag is string => tag !== undefined);
    const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    lines.push(`${indent}- seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} ${entrySummary(entry)}${suffix}`);

    const children = childrenOf(entries, entry.id).toSorted((a, b) => a.seq - b.seq);
    for (const child of children) {
      visit(child, depth + 1);
    }
  }

  const roots = childrenOf(entries, null).toSorted((a, b) => a.seq - b.seq);
  for (const root of roots) {
    visit(root, 0);
  }

  return lines.join("\n");
}
