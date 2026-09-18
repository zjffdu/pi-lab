import type { Entry, MessageEntry } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { findBranchTips, renderTree } from "../src/tree-view.js";

function messageEntry(id: string, parentId: string | null, seq: number, role: "user" | "assistant", text: string): MessageEntry {
  return {
    id,
    parentId,
    seq,
    timestamp: seq,
    type: "message",
    message:
      role === "user"
        ? { role: "user", content: text, timestamp: seq }
        : {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
              input: 10,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 20,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: seq,
          },
  };
}

describe("findBranchTips", () => {
  it("returns the single leaf of a linear chain", () => {
    const entries: Entry[] = [
      messageEntry("1", null, 1, "user", "hi"),
      messageEntry("2", "1", 2, "assistant", "hello"),
    ];
    expect(findBranchTips(entries)).toEqual(["2"]);
  });

  it("returns every leaf once the tree forks", () => {
    const entries: Entry[] = [
      messageEntry("1", null, 1, "user", "look up BK1001"),
      messageEntry("2", "1", 2, "assistant", "BK1001 details"),
      messageEntry("3", "2", 3, "user", "check events"),
      messageEntry("4", "3", 4, "assistant", "events summary"),
      messageEntry("5", "2", 5, "user", "actually BK1002"),
      messageEntry("6", "5", 6, "assistant", "BK1002 details"),
    ];
    expect(findBranchTips(entries).toSorted()).toEqual(["4", "6"]);
  });

  it("returns an empty array for an empty tree", () => {
    expect(findBranchTips([])).toEqual([]);
  });
});

describe("renderTree", () => {
  it("renders each branch on its own indented line and tags tips, the active tip, and labels", () => {
    const entries: Entry[] = [
      messageEntry("1", null, 1, "user", "look up BK1001"),
      messageEntry("2", "1", 2, "assistant", "BK1001 details"),
      messageEntry("3", "2", 3, "user", "actually BK1002"),
      messageEntry("4", "3", 4, "assistant", "BK1002 details"),
    ];

    const output = renderTree(entries, { labels: new Map([["2", "after-bk1001-lookup"]]), activeTipId: "4" });
    const lines = output.split("\n");

    expect(lines[0]).toContain("id=1");
    expect(lines[0]).not.toContain("[");
    expect(lines[1]).toContain("id=2");
    expect(lines[1]).toContain('label="after-bk1001-lookup"');
    expect(lines[2]).toContain("id=3");
    expect(lines[3]).toContain("id=4");
    expect(lines[3]).toContain("TIP");
    expect(lines[3]).toContain("ACTIVE");
  });
});
