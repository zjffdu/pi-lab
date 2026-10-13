import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { type Branch, branchTips, describeFork, inheritedEntries, ownEntries, renderTree, tipOf } from "../src/tree-view.js";

const cid = (n: number) => n as ConversationId;
const eid = (n: number) => n as EntryId;

function user(id: number, conversation: number, text: string): EntryRecord {
  return {
    id: eid(id),
    conversationId: cid(conversation),
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: id }],
  };
}

function assistant(id: number, conversation: number, text: string): EntryRecord {
  return {
    id: eid(id),
    conversationId: cid(conversation),
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: id,
      },
    ],
  };
}

// Conversation 1 is the root: entries 1..4. Conversation 5 forks it at entry 2 and adds 6, 7.
// Fork entries inherit 1 and 2 with the parent's conversationId.
const rootEntries = [user(1, 1, "Look up BK1001"), assistant(2, 1, "BK1001 on MAERSK TEST"), user(3, 1, "risk?"), assistant(4, 1, "on schedule")];
const root: Branch = { record: { id: cid(1) }, entries: rootEntries };
const fork: Branch = {
  record: { id: cid(5), parent: { conversationId: cid(1), at: eid(2) } },
  entries: [rootEntries[0]!, rootEntries[1]!, user(6, 5, "Actually BK1002"), assistant(7, 5, "BK1002 on MAERSK SECOND")],
};
const freshFork: Branch = {
  record: { id: cid(8), parent: { conversationId: cid(1), at: eid(4) } },
  entries: rootEntries,
};

describe("own vs inherited entries", () => {
  it("separates a fork's shared prefix from its own continuation by conversationId", () => {
    expect(inheritedEntries(fork).map((entry) => entry.id)).toEqual([1, 2]);
    expect(ownEntries(fork).map((entry) => entry.id)).toEqual([6, 7]);
    expect(ownEntries(root).map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(inheritedEntries(root)).toEqual([]);
  });

  it("treats a fork with no entries of its own as inheriting everything it can see", () => {
    expect(ownEntries(freshFork)).toEqual([]);
    expect(tipOf(freshFork)?.id).toBe(4);
  });
});

describe("branchTips", () => {
  it("returns one tip per conversation: its newest visible entry", () => {
    expect(branchTips([root, fork])).toEqual([
      { conversationId: 1, entryId: 4 },
      { conversationId: 5, entryId: 7 },
    ]);
  });

  it("reports no entry for a conversation that has none", () => {
    expect(branchTips([{ record: { id: cid(9) }, entries: [] }])).toEqual([{ conversationId: 9, entryId: undefined }]);
  });
});

describe("describeFork", () => {
  it("names the parent conversation and the fork point", () => {
    expect(describeFork(fork.record)).toBe("conversation 5 forked from conversation 1 at entry 2");
    expect(describeFork(root.record)).toBe("conversation 1 is the root");
  });
});

describe("renderTree", () => {
  it("prints the shared prefix once and nests the fork right after its fork point", () => {
    const output = renderTree([root, fork], { labels: new Map([["2", "after-bk1001-lookup"]]), selected: cid(5) });

    expect(output.split("\n")).toEqual([
      "conversation 1 (root)",
      '  1 pi.user "Look up BK1001"',
      '  2 pi.assistant "BK1001 on MAERSK TEST" [label="after-bk1001-lookup"]',
      "    conversation 5 (fork of 1 @ entry 2)  ◀ selected",
      '      6 pi.user "Actually BK1002"',
      '      7 pi.assistant "BK1002 on MAERSK SECOND" [TIP]',
      '  3 pi.user "risk?"',
      '  4 pi.assistant "on schedule" [TIP]',
    ]);
  });

  it("marks a fork with no entries of its own as sitting on an inherited tip", () => {
    const output = renderTree([root, freshFork], { labels: new Map() });

    expect(output).toContain("conversation 8 (fork of 1 @ entry 4)  [tip: entry 4, inherited — no entries of its own yet]");
  });

  it("nests a fork of a fork one level deeper", () => {
    const nested: Branch = {
      record: { id: cid(10), parent: { conversationId: cid(5), at: eid(6) } },
      entries: [rootEntries[0]!, rootEntries[1]!, fork.entries[2]!, user(11, 10, "and the third premise")],
    };
    const lines = renderTree([root, fork, nested], { labels: new Map() }).split("\n");

    expect(lines).toContain("        conversation 10 (fork of 5 @ entry 6)");
    expect(lines).toContain('          11 pi.user "and the third premise" [TIP]');
  });
});
