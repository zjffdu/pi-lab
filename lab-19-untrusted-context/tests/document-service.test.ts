import { describe, expect, it } from "vitest";

import { PROJECTED_FIELDS, projectDocument } from "../src/document-service.js";
import { loadDocuments } from "../src/document-repository.js";
import { ctx, newDocuments } from "./unit-helpers.js";

describe("ACL is applied before retrieval", () => {
  it("a viewer's search for a restricted document behaves exactly like a search with no match", () => {
    const { documents } = newDocuments();
    const restricted = documents.search(ctx("tenant-a", "carol"), "pricing exceptions rebate");
    const nothing = documents.search(ctx("tenant-a", "carol"), "zzz unmatched words");
    expect(restricted.hits).toEqual([]);
    expect({ ...restricted, query: "" }).toEqual({ ...nothing, query: "" });
  });

  it("the subject the ACL names can read it", () => {
    const { documents } = newDocuments();
    const outcome = documents.search(ctx("tenant-a", "dave"), "pricing exceptions rebate");
    expect(outcome.hits.map((hit) => hit.sourceId)).toEqual(["RESTRICTED-PRICING"]);
  });

  it("a restricted source contributes no hit, score, or conflict sibling for other principals", () => {
    const { documents } = newDocuments();
    const carol = documents.search(ctx("tenant-a", "carol"), "customs hold pricing rebate");
    expect(carol.hits.map((hit) => hit.sourceId)).not.toContain("RESTRICTED-PRICING");
  });

  it("read treats an unreadable source exactly like an unknown one", () => {
    const { documents } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    expect(documents.read(carol, "RESTRICTED-PRICING")).toBeUndefined();
    expect(documents.read(carol, "DOES-NOT-EXIST")).toBeUndefined();
  });
});

describe("tenant isolation with colliding source IDs", () => {
  it("KB-100 resolves to the caller's own tenant's document", () => {
    const { documents } = newDocuments();
    const a = documents.read(ctx("tenant-a", "alice"), "KB-100");
    const b = documents.read(ctx("tenant-b", "erin"), "KB-100");
    expect(a?.body).toContain("customs broker");
    expect(b?.body).toContain("Tenant B procedure");
    expect(JSON.stringify(a)).not.toContain("TENANTB-CANARY");
    expect(JSON.stringify(b)).not.toContain("customs broker");
  });

  it("search never returns another tenant's document", () => {
    const { documents } = newDocuments();
    const outcome = documents.search(ctx("tenant-a", "alice"), "customs hold procedure escalate");
    expect(JSON.stringify(outcome)).not.toContain("TENANTB-CANARY");
  });
});

describe("projection allowlist", () => {
  it("builds views from exactly the allowed fields", () => {
    const [doc] = loadDocuments();
    const view = projectDocument(doc!, new Date("2026-09-20"));
    expect(Object.keys(view).sort()).toEqual([...PROJECTED_FIELDS].filter((field) => field in view).sort());
    expect(Object.keys(view)).not.toContain("acl");
    expect(Object.keys(view)).not.toContain("sensitive");
    expect(Object.keys(view)).not.toContain("marker");
  });

  it("an authorized document's sensitive fields never appear in a view or a search outcome", () => {
    const { documents } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    const view = documents.read(carol, "CONTACT-SHEET");
    const outcome = documents.search(carol, "customer contact customs paperwork");
    expect(view?.body).toContain("prefers updates by email");
    for (const serialized of [JSON.stringify(view), JSON.stringify(outcome)]) {
      expect(serialized).not.toContain("jane.doe@customer-a.example");
      expect(serialized).not.toContain("INTERNAL-ONLY-NOTE-5522");
    }
  });
});

describe("freshness, conflict, and missing evidence", () => {
  it("marks a superseded source, and an old one once the clock has moved on", () => {
    const now = newDocuments();
    expect(now.documents.read(ctx("tenant-a", "carol"), "SCHED-2024")?.freshness).toBe("superseded");
    expect(now.documents.read(ctx("tenant-a", "carol"), "KB-100")?.freshness).toBe("current");
    const later = newDocuments(new Date("2027-06-01T00:00:00Z"));
    expect(later.documents.read(ctx("tenant-a", "carol"), "KB-100")?.freshness).toBe("stale");
  });

  it("reports two sources that disagree about one topic", () => {
    const { documents } = newDocuments();
    const outcome = documents.search(ctx("tenant-a", "carol"), "BK1001 customs status");
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.topic).toBe("bk1001-customs-status");
    expect(outcome.conflicts[0]?.sources.map((source) => source.value).sort()).toEqual(["hold", "released"]);
  });

  it("shows the disagreeing source even when only one side matched the query", () => {
    const { documents } = newDocuments();
    const outcome = documents.search(ctx("tenant-a", "carol"), "phytosanitary");
    expect(outcome.hits.map((hit) => hit.sourceId).sort()).toEqual(["NOTE-BK1001-A", "NOTE-BK1001-B"]);
    expect(outcome.conflicts).toHaveLength(1);
  });

  it("returns no hits for an unmatched or stopword-only query", () => {
    const { documents } = newDocuments();
    expect(documents.search(ctx("tenant-a", "carol"), "quantum widget").hits).toEqual([]);
    expect(documents.search(ctx("tenant-a", "carol"), "the of to").hits).toEqual([]);
  });
});

describe("retrieval cache is rechecked, not trusted", () => {
  it("serves a repeat query from cache while access and version are unchanged", () => {
    const { documents, cache } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    const first = documents.search(carol, "customs hold procedure");
    expect(documents.search(carol, "customs hold procedure")).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("does not serve a cached hit after the source's ACL is revoked", () => {
    const { documents, repository } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    expect(documents.search(carol, "customs hold procedure").hits.map((hit) => hit.sourceId)).toContain("KB-100");
    repository.setAcl("tenant-a", "KB-100", { roles: [], subjects: [] });
    expect(documents.search(carol, "customs hold procedure").hits.map((hit) => hit.sourceId)).not.toContain("KB-100");
  });

  it("does not serve a cached hit after the caller's role is revoked", () => {
    const { documents, directory } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    documents.search(carol, "customs hold procedure");
    directory.revokeRole("tenant-a", "carol", "viewer");
    expect(documents.search(carol, "customs hold procedure").hits).toEqual([]);
  });

  it("does not serve a cached hit after a new version is published", () => {
    const { documents, repository } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    documents.search(carol, "customs hold procedure");
    repository.publishVersion("tenant-a", "KB-100", { body: "Revised procedure: customs hold requires a supervisor.", updatedAt: "2026-09-19" });
    const hit = documents.search(carol, "customs hold procedure").hits.find((candidate) => candidate.sourceId === "KB-100");
    expect(hit?.version).toBe(3);
    expect(hit?.body).toContain("supervisor");
  });

  it("keeps two subjects' entries apart", () => {
    const { documents, cache } = newDocuments();
    documents.search(ctx("tenant-a", "carol"), "pricing exceptions rebate");
    const dave = documents.search(ctx("tenant-a", "dave"), "pricing exceptions rebate");
    expect(dave.hits).toHaveLength(1);
    expect(cache.size).toBe(2);
  });
});

describe("forbidden values", () => {
  it("lists the unreadable sources' bodies and markers, and every sensitive field, for a viewer", () => {
    const { documents } = newDocuments();
    const values = documents.forbiddenValues(ctx("tenant-a", "carol")).map((item) => item.value);
    expect(values).toContain("RST-CANARY-4471");
    expect(values).toContain("TENANTB-CANARY-9931");
    expect(values).toContain("jane.doe@customer-a.example");
    expect(values).toContain("INTERNAL-ONLY-NOTE-5522: customer is disputing an invoice");
  });

  it("drops a source from the list once the caller may read it, but keeps sensitive fields for everyone", () => {
    const { documents } = newDocuments();
    const values = documents.forbiddenValues(ctx("tenant-a", "dave")).map((item) => item.value);
    expect(values).not.toContain("RST-CANARY-4471");
    expect(values).toContain("INTERNAL-ONLY-NOTE-5522: customer is disputing an invoice");
  });

  it("labels never contain the values themselves", () => {
    const { documents } = newDocuments();
    for (const item of documents.forbiddenValues(ctx("tenant-a", "carol"))) expect(item.label).not.toContain(item.value);
  });
});

describe("a cached outcome cannot assert 'no evidence' or 'no conflict' after access changes", () => {
  it("a grant makes a previously empty result non-empty", () => {
    const { documents, repository } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    expect(documents.search(carol, "pricing exceptions rebate").hits).toEqual([]);
    repository.setAcl("tenant-a", "RESTRICTED-PRICING", { roles: [], subjects: ["dave", "carol"] });
    expect(documents.search(carol, "pricing exceptions rebate").hits.map((hit) => hit.sourceId)).toEqual(["RESTRICTED-PRICING"]);
  });

  it("a newly readable conflicting sibling turns a cached 'no conflict' into a conflict", () => {
    const { documents, repository } = newDocuments();
    const carol = ctx("tenant-a", "carol");
    repository.setAcl("tenant-a", "NOTE-BK1001-B", { roles: [], subjects: [] });
    expect(documents.search(carol, "phytosanitary").conflicts).toEqual([]);
    repository.setAcl("tenant-a", "NOTE-BK1001-B", { roles: ["viewer"], subjects: [] });
    expect(documents.search(carol, "phytosanitary").conflicts).toHaveLength(1);
  });
});

describe("freshness drifts with time", () => {
  it("a cached result is not served once the clock has made a source stale", () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const { documents } = newDocuments(() => now);
    const carol = ctx("tenant-a", "carol");
    expect(documents.search(carol, "procedure broker clearance").hits[0]?.freshness).toBe("current");
    now = new Date("2027-06-01T00:00:00Z");
    expect(documents.search(carol, "procedure broker clearance").hits[0]?.freshness).toBe("stale");
  });
});
