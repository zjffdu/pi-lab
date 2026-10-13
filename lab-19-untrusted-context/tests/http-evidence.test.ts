import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvidenceCollector } from "../src/evidence.js";

import { callThenAnswer, lastSessionId, say, startHarness, toolCall, whereInRequests, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  // A hook that threw is swallowed and reported, not raised; a healthy run reports nothing.
  expect(h.reports).toEqual([]);
  await h.close();
});

const allRequests = () => h.providerRequests.join("\n");

describe("unauthorized source contents never enter provider requests", () => {
  it("a viewer's search for a restricted document surfaces nothing and says the evidence is missing", async () => {
    h.script(callThenAnswer("search_documents", { query: "pricing exceptions rebate" }, "I found no evidence."));
    const res = await h.as("tenant-a", "carol").chat("What is the pricing exception rebate?");
    expect(res.status).toBe(200);
    expect(allRequests()).not.toContain("RST-CANARY-4471");
    expect(allRequests()).not.toContain("40 percent rebate");
    expect(allRequests()).toContain("NO_EVIDENCE");
    expect(res.body.evidence.status).toBe("no_evidence");
  });

  it("the subject the ACL names does receive it (the check is the ACL, not the query)", async () => {
    h.script(callThenAnswer("search_documents", { query: "pricing exceptions rebate" }, "A 40 percent rebate applies. [RESTRICTED-PRICING@1]"));
    const res = await h.as("tenant-a", "dave").chat("What is the pricing exception rebate?");
    expect(allRequests()).toContain("RST-CANARY-4471");
    expect(res.body.evidence.status).toBe("supported");
    expect(res.body.citations.verified).toBe(true);
  });

  it("reading a restricted ID and reading an unknown ID produce the same error text", async () => {
    h.script([toolCall("read_document", { sourceId: "RESTRICTED-PRICING" }), say("no access")]);
    await h.as("tenant-a", "carol").chat("read it");
    const restricted = h.providerRequests[1] ?? "";
    h.script([toolCall("read_document", { sourceId: "NOPE-1" }), say("no access")]);
    await h.as("tenant-a", "carol").chat("read it");
    const unknown = h.providerRequests[3] ?? "";
    const normalize = (text: string, id: string) => (text.match(/No accessible document with ID [^.]*\./)?.[0] ?? "").replace(id, "ID");
    expect(normalize(restricted, '\\"RESTRICTED-PRICING\\"')).toBe(normalize(unknown, '\\"NOPE-1\\"'));
    expect(normalize(restricted, '\\"RESTRICTED-PRICING\\"')).not.toBe("");
    expect(restricted).not.toContain("RST-CANARY-4471");
  });
});

describe("cross-tenant documents", () => {
  it("each tenant's search returns only its own KB-100, and neither request contains the other's text", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance escalate desk" }, "See [KB-100@2]."));
    const a = await h.as("tenant-a", "alice").chat("customs hold procedure?");
    const aRequests = allRequests();
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance escalate desk" }, "See [KB-100@1]."));
    const b = await h.as("tenant-b", "erin").chat("customs hold procedure?");
    const bRequests = h.providerRequests.slice(2).join("\n");

    expect(aRequests).toContain("customs broker");
    expect(aRequests).not.toContain("TENANTB-CANARY-9931");
    expect(bRequests).toContain("TENANTB-CANARY-9931");
    expect(bRequests).not.toContain("customs broker");
    expect(a.body.citations.verified).toBe(true);
    expect(b.body.citations.verified).toBe(true);
  });

  it("a citation with the other tenant's version of a colliding ID does not resolve", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "See [KB-100@1]."));
    const res = await h.as("tenant-a", "alice").chat("customs hold procedure?");
    expect(res.body.citations.verified).toBe(false);
    expect(res.body.citations.unresolved).toEqual([{ sourceId: "KB-100", version: 1 }]);
  });
});

describe("sensitive result fields", () => {
  it("never reach a provider request, the durable session, or the answer, even for an authorized document", async () => {
    h.script(callThenAnswer("read_document", { sourceId: "CONTACT-SHEET" }, "The customer prefers email updates. [CONTACT-SHEET@1]"));
    const res = await h.as("tenant-a", "carol").chat("Read the contact sheet.");
    expect(res.status).toBe(200);
    expect(allRequests()).toContain("prefers updates by email");
    const durable = await h.sessionFilesText();
    for (const secret of ["jane.doe@customer-a.example", "INTERNAL-ONLY-NOTE-5522"]) {
      expect(allRequests()).not.toContain(secret);
      expect(durable).not.toContain(secret);
      expect(res.body.answer).not.toContain(secret);
    }
  });

  it("an answer that repeats a sensitive value is withheld", async () => {
    h.script(callThenAnswer("read_document", { sourceId: "CONTACT-SHEET" }, "Email jane.doe@customer-a.example"));
    const res = await h.as("tenant-a", "carol").chat("Read the contact sheet.");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("output_scope_violation");
    expect(JSON.stringify(res.body)).not.toContain("jane.doe");
  });
});

describe("evidence status: stale, conflicting, missing", () => {
  it("stale: a superseded source is flagged in the tool result and the run's evidence", async () => {
    h.script(callThenAnswer("search_documents", { query: "vessel schedule ALPHA EXPRESS departs" }, "An old schedule says Mondays. [SCHED-2024@1]"));
    const res = await h.as("tenant-a", "carol").chat("When does ALPHA EXPRESS depart?");
    expect(allRequests()).toContain("STALE:");
    expect(allRequests()).toContain('freshness=\\"superseded\\"');
    expect(res.body.evidence.status).toBe("stale");
    expect(res.body.evidence.staleSources).toEqual([{ sourceId: "SCHED-2024", version: 1 }]);
  });

  it("conflicting: both sides are shown and the status is conflicting, not silently resolved", async () => {
    h.script(callThenAnswer("search_documents", { query: "BK1001 customs status" }, "Sources disagree. [NOTE-BK1001-A@1] [NOTE-BK1001-B@1]"));
    const res = await h.as("tenant-a", "carol").chat("Is BK1001 on customs hold?");
    expect(allRequests()).toContain("CONFLICT:");
    expect(allRequests()).toContain("NOTE-BK1001-A");
    expect(allRequests()).toContain("NOTE-BK1001-B");
    expect(res.body.evidence.status).toBe("conflicting");
    expect(res.body.evidence.conflicts).toHaveLength(1);
    expect(res.body.citations.verified).toBe(true);
  });

  it("missing: no authorized match is reported as missing evidence", async () => {
    h.script(callThenAnswer("search_documents", { query: "quantum widget" }, "I found no evidence."));
    const res = await h.as("tenant-a", "carol").chat("Anything about quantum widgets?");
    expect(allRequests()).toContain("NO_EVIDENCE");
    expect(res.body.evidence.status).toBe("no_evidence");
    expect(res.body.evidence.sources).toEqual([]);
  });

  it("not_retrieved: an answer with no document tool call is marked as such", async () => {
    h.script([say("From memory: probably.")]);
    const res = await h.as("tenant-a", "carol").chat("What is the customs procedure?");
    expect(res.body.evidence.status).toBe("not_retrieved");
  });
});

describe("citations resolve to real sources and versions", () => {
  it("resolves a cited source that was returned", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "Contact the broker. [KB-100@2]"));
    const res = await h.as("tenant-a", "carol").chat("customs procedure?");
    expect(res.body.citations).toMatchObject({ verified: true, resolved: [{ sourceId: "KB-100", version: 2 }], unresolved: [] });
  });

  it("flags a fabricated source, a wrong version, and a real source that was never retrieved", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "[KB-999@1] [KB-100@9] [MAIL-7001@1]"));
    const res = await h.as("tenant-a", "carol").chat("customs procedure?");
    expect(res.body.citations.verified).toBe(false);
    expect(res.body.citations.unresolved).toHaveLength(3);
    expect(res.body.citations.resolved).toEqual([]);
  });

  it("resolves a source retrieved in an earlier turn of the same conversation", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "First answer. [KB-100@2]"));
    const first = await h.as("tenant-a", "carol").chat("customs procedure?");
    h.script([say("Repeating: [KB-100@2]")]);
    const second = await h.as("tenant-a", "carol").chat("say it again", first.body.sessionId);
    expect(second.body.citations.verified).toBe(true);
  });
});

/**
 * Pi 1.1 has no hook that can stop a provider request (a throw in `beforeRequest` is reported and the request
 * is sent anyway), so the layers that *prevent* a leak sit earlier — the preflight before `submit()` and the
 * tools' write-time gate — and the request-time hook withholds and records. These tests assert both halves of
 * every blocked case: the value is in no provider request and not in durable state, *and* the run reports failure.
 * (0.85.1 asserted "502 and exactly one provider request"; that count no longer describes the mechanism.)
 */
describe("when scoping fails upstream, each remaining layer holds", () => {
  const breakSearch = () => {
    const leaked = h.app.repository.get("tenant-a", "RESTRICTED-PRICING")!;
    (h.app.documents as { search: unknown }).search = () => ({
      query: "q",
      hits: [{ sourceId: leaked.sourceId, version: leaked.version, title: leaked.title, topic: leaked.topic, updatedAt: leaked.updatedAt, freshness: "current", body: leaked.body }],
      conflicts: [],
    });
  };

  it("write-time gate: a retrieval bug returning a restricted source is refused by the tool, so the value is never written, never sent, and the run fails", async () => {
    breakSearch();
    h.script(callThenAnswer("search_documents", { query: "anything" }, "I could not look that up."));
    const res = await h.as("tenant-a", "carol").chat("Look something up.");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("run_failed");
    expect(h.runFailures.join(" ")).toMatch(/write gate refused a tool result: search_documents\(.*unreadable-source:tenant-a\/RESTRICTED-PRICING/);
    expect(allRequests()).not.toContain("RST-CANARY-4471");
    expect(whereInRequests(h.providerMessages, "RST-CANARY-4471")).toEqual([]);
    expect(await h.sessionFilesText()).not.toContain("RST-CANARY-4471");
    expect(JSON.stringify(res.body)).not.toContain("RST-CANARY-4471");
    expect(h.traceLines.join("\n")).toMatch(/⛔ write_gate_refused search_documents labels=\[.*unreadable-source:tenant-a\/RESTRICTED-PRICING/);
    expect(h.reports).toEqual([]);
  });

  it("write-time gate: nothing durable holds the value, so the session is not bricked — the next request on it runs", async () => {
    breakSearch();
    h.script(callThenAnswer("search_documents", { query: "anything" }, "no"));
    const first = await h.as("tenant-a", "carol").chat("Look something up.");
    expect(first.status).toBe(502);
    const sessionId = await lastSessionId(h);

    h.script([say("Still here.")]);
    const next = await h.as("tenant-a", "carol").chat("Are you there?", sessionId);
    expect(next.status).toBe(200);
    expect(next.body.answer).toBe("Still here.");
  });

  /**
   * Access is revoked after the tool's write-time gate has passed and before the next provider request is
   * built. `EvidenceCollector.record` is the one call that sits exactly there: the tool calls it after its gate
   * and before it returns.
   */
  const revokeAfterSearch = () => {
    const record = EvidenceCollector.prototype.record;
    vi.spyOn(EvidenceCollector.prototype, "record").mockImplementation(function (this: EvidenceCollector, details) {
      record.call(this, details);
      h.app.repository.setAcl("tenant-a", "KB-100", { roles: [], subjects: [] });
    });
  };

  it("request-time backstop: a source revoked mid-run is withheld from the next provider request, and the run fails", async () => {
    revokeAfterSearch();
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "Talk to the broker. [KB-100@2]"));
    const res = await h.as("tenant-a", "alice").chat("customs procedure?");

    expect(res.status).toBe(502);
    expect(h.runFailures.join(" ")).toMatch(/egress backstop withheld: .*KB-100@2/);
    // The second provider request is the one that would have carried the revoked source's text.
    expect(h.providerRequests).toHaveLength(2);
    expect(h.providerRequests[1]).not.toContain("record the hold reason in the case notes");
    expect(h.providerRequests[1]).toContain("[withheld by egress guard]");
    expect(h.traceLines.join("\n")).toMatch(/⛔ egress_withheld (unreadable_source|forbidden_content)/);
  });

  it("request-time backstop: the session is then refused, because the stored result is revoked", async () => {
    revokeAfterSearch();
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "ok"));
    await h.as("tenant-a", "alice").chat("customs procedure?");
    const sessionId = await lastSessionId(h);

    const callsBefore = h.faux.state.callCount;
    h.script([say("must not be requested")]);
    const next = await h.as("tenant-a", "alice").chat("continue", sessionId);
    expect(next.status).toBe(409);
    expect(h.faux.state.callCount).toBe(callsBefore);
  });

  it("preflight: a prompt that itself carries a forbidden value is refused before any provider request", async () => {
    h.script([say("never")]);
    const res = await h.as("tenant-a", "carol").chat("Summarize this: RST-CANARY-4471");
    expect(res.status).toBe(502);
    expect(h.faux.state.callCount).toBe(0);
    expect(h.runFailures.join(" ")).toMatch(/preflight: the prompt contains forbidden value/);
  });
});
