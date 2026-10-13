import { describe, expect, it } from "vitest";

import { assessBranch, type EntryLike } from "../src/context-provenance.js";

const user = (id: string): EntryLike => ({ id, kind: "pi.user", message: { role: "user", content: "q" } });
const assistant = (id: string): EntryLike => ({ id, kind: "pi.assistant", message: { role: "assistant", content: "a" } });
const docResult = (id: string, sources: unknown, toolName = "search_documents"): EntryLike => ({
  id,
  kind: "pi.tool-result",
  message: { role: "toolResult", toolName, content: "r", details: sources === undefined ? undefined : { sources } },
});
/** Pi 1.1 stores a compaction summary as a *user-role* message on a `pi.compaction` entry. */
const compaction = (id: string): EntryLike => ({ id, kind: "pi.compaction", message: { role: "user", content: "The conversation history before this point was compacted into the following summary: ..." } });
const ref = (sourceId: string, version = 1) => ({ sourceId, version });
const allow = (...ids: string[]) => (candidate: { sourceId: string }) => ids.includes(candidate.sourceId);

describe("assessBranch", () => {
  it("is clean when every source is still readable, and lists them", () => {
    const result = assessBranch([user("u1"), assistant("a1"), docResult("t1", [ref("KB-100", 2)]), assistant("a2")], allow("KB-100"));
    expect(result.verdict).toBe("clean");
    expect(result.refs).toEqual([ref("KB-100", 2)]);
    expect(result.taintedEntryIds.size).toBe(0);
  });

  it("taints the revoked result and everything derived after it, but not user messages or the earlier tool-calling turn", () => {
    const entries = [user("u1"), assistant("a-call"), docResult("t1", [ref("KB-100")]), assistant("a-answer"), user("u2"), assistant("a2"), compaction("c1")];
    const result = assessBranch(entries, allow());
    expect(result.verdict).toBe("revoked");
    expect(result.revoked).toEqual([ref("KB-100")]);
    expect([...result.taintedEntryIds].sort()).toEqual(["a-answer", "a2", "c1", "t1"]);
  });

  it("a readable result before a revoked one is not tainted", () => {
    const entries = [docResult("t1", [ref("KB-100")]), assistant("a1"), docResult("t2", [ref("SECRET")]), assistant("a2")];
    const result = assessBranch(entries, allow("KB-100"));
    expect([...result.taintedEntryIds].sort()).toEqual(["a2", "t2"]);
  });

  it("a result naming several sources is revoked if any one is", () => {
    const result = assessBranch([docResult("t1", [ref("KB-100"), ref("SECRET")])], allow("KB-100"));
    expect(result.verdict).toBe("revoked");
    expect(result.revoked).toEqual([ref("SECRET")]);
  });

  it("fails closed as unattributable when a document-tool result has no usable provenance record", () => {
    for (const sources of [undefined, "KB-100", [{ sourceId: 5 }], [{ sourceId: "KB-100", version: "2" }]]) {
      const result = assessBranch([docResult("t1", sources), assistant("a1")], allow("KB-100"));
      expect(result.verdict).toBe("unattributable");
      expect(result.unattributable).toEqual(["t1"]);
      expect(result.taintedEntryIds.has("a1")).toBe(true);
    }
  });

  it("ignores tool results from tools that do not read documents", () => {
    const result = assessBranch([docResult("t1", undefined, "propose_booking_status_change"), assistant("a1")], allow());
    expect(result.verdict).toBe("clean");
  });
});

describe("assessBranch — review regressions", () => {
  const failedRead = (id: string): EntryLike => ({ id, kind: "pi.tool-result", message: { role: "toolResult", toolName: "read_document", content: "No accessible document.", isError: true } });

  it("a failed document-tool call carries no document text and is not 'unattributable'", () => {
    const result = assessBranch([failedRead("t1"), assistant("a1")], allow());
    expect(result.verdict).toBe("clean");
  });

  it("a successful result without provenance is still unattributable even if a failed one precedes it", () => {
    expect(assessBranch([failedRead("t1"), docResult("t2", undefined)], allow()).verdict).toBe("unattributable");
  });

  it("stored text containing a forbidden value makes the branch contaminated, and taints that entry and later derived ones", () => {
    const echoed: EntryLike = { id: "a1", kind: "pi.assistant", message: { role: "assistant", content: [{ type: "text", text: "Email jane@x.example" }] } };
    const result = assessBranch([user("u1"), echoed, assistant("a2"), user("u2")], allow(), (text) => text.includes("jane@x.example"));
    expect(result.verdict).toBe("contaminated");
    expect([...result.taintedEntryIds].sort()).toEqual(["a1", "a2"]);
  });

  it("treats an entry type it does not know as derived (default-deny)", () => {
    const result = assessBranch([docResult("t1", [ref("SECRET")]), { id: "x1", kind: "app.custom" }], allow());
    expect(result.taintedEntryIds.has("x1")).toBe(true);
  });
});

describe("assessBranch — Pi 1.1 entry kinds", () => {
  it("a compaction entry is derived even though its message has the user role", () => {
    const result = assessBranch([docResult("t1", [ref("SECRET")]), compaction("c1"), user("u2")], allow());
    expect(result.taintedEntryIds.has("c1")).toBe(true);
    expect(result.taintedEntryIds.has("u2")).toBe(false);
  });

  it("a system entry after a revoked result is tainted but is not something history would show", () => {
    const system: EntryLike = { id: "s1", kind: "pi.system", message: { role: "system", content: "" } };
    expect(assessBranch([docResult("t1", [ref("SECRET")]), system], allow()).taintedEntryIds.has("s1")).toBe(true);
  });

  it("numeric ids (as Pi 1.1 assigns them) work", () => {
    const entries: EntryLike[] = [{ id: 1, kind: "pi.user", message: { role: "user", content: "q" } }, { ...docResult("x", [ref("SECRET")]), id: 2 }, { ...assistant("x"), id: 3 }];
    expect([...assessBranch(entries, allow()).taintedEntryIds].sort()).toEqual([2, 3]);
  });
});
