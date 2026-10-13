import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BookingLookupService } from "../src/connector/lookup.js";
import { DEFAULT_LIMITS, RunBudget } from "../src/run-budget.js";
import { AttemptTrace } from "../src/connector/trace.js";
import { BK1001_CONTAINERS, contextFor, NOW, scopeFor, startConnector, type ConnectorRig } from "./helpers.js";

/**
 * The connector against the local fake API, without Pi: what a *valid* answer looks like, what a
 * defective one looks like, and that a defect is never mistaken for data. Every row of the schema
 * table is a real HTTP response that is wrong in one way.
 */
let rig: ConnectorRig;
beforeEach(async () => {
  rig = await startConnector();
});
afterEach(async () => {
  await rig.close();
});

const service = () => new BookingLookupService({ connector: rig.connector, clock: () => NOW });

describe("successful lookup", () => {
  it("follows the cursor across every page and computes the totals over the validated data", async () => {
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    expect(outcome).toMatchObject({ kind: "found", bookingNo: "BK1001", status: "booked", freshness: "fresh", cutoffPassed: false });
    if (outcome.kind !== "found") throw new Error("unreachable");
    expect(outcome.containers).toMatchObject({ complete: true, expected: 5, pagesFetched: 3, totalWeightKg: 52250 });
    expect(rig.api.requestsFor("containers")).toHaveLength(3);
  });

  it("colliding booking numbers resolve by the caller's tenant: BK1001 differs per tenant", async () => {
    const a = await service().lookup(scopeFor(), contextFor("tenant-a"), "BK1001");
    const b = await service().lookup(scopeFor(), contextFor("tenant-b", "erin"), "BK1001");
    if (a.kind !== "found" || b.kind !== "found") throw new Error("expected both to be found");
    expect([a.status, a.containers.totalWeightKg]).toEqual(["booked", 52250]);
    expect([b.status, b.containers.totalWeightKg]).toEqual(["in_transit", 60000]);
    expect(rig.api.log.map((entry) => entry.tenant)).toEqual(expect.arrayContaining(["tenant-a", "tenant-b"]));
  });

  it("a booking that does not exist is an answer (no result), not a failure, and is asked for once", async () => {
    expect(await service().lookup(scopeFor(), contextFor(), "BK9999")).toEqual({ kind: "not_found", bookingNo: "BK9999" });
    expect(rig.api.log).toHaveLength(1);
    expect(rig.sleeps).toEqual([]);
  });

  it("another tenant's booking is 'no result' too — the API is asked in the caller's tenant only", async () => {
    // BK4001 exists only in tenant-a.
    expect(await service().lookup(scopeFor(), contextFor("tenant-b", "erin"), "BK4001")).toEqual({ kind: "not_found", bookingNo: "BK4001" });
    expect(rig.api.log.every((entry) => entry.tenant === "tenant-b")).toBe(true);
  });

  it("does not pass on fields outside the contract", async () => {
    const result = await rig.connector.getBooking(scopeFor(), contextFor(), "BK1001");
    if (!result.found) throw new Error("expected found");
    expect(Object.keys(result.booking).sort()).toEqual(["bookingNo", "containerNos", "documentCutoff", "status", "updatedAt"]);
    expect(JSON.stringify(result)).not.toContain("internalNote");
  });
});

describe("schema validation — a defective answer is a malformed_response, never data, and is not retried", () => {
  const cases: Array<[string, () => void]> = [
    ["a required field is missing", () => rig.api.inject({ kind: "drop-field", field: "data.status" }, { route: "booking" })],
    ["the container list arrives as a string", () => rig.api.inject({ kind: "wrong-type", field: "data.containerNos", value: "MSKU0000001" }, { route: "booking" })],
    ["a booking claims no containers", () => rig.api.inject({ kind: "wrong-type", field: "data.containerNos", value: [] }, { route: "booking" })],
    ["a booking names the same container twice", () => rig.api.inject({ kind: "wrong-type", field: "data.containerNos", value: ["MSKU0000001", "MSKU0000001"] }, { route: "booking" })],
    ["a container number is not a string", () => rig.api.inject({ kind: "wrong-type", field: "data.containerNos", value: ["MSKU0000001", 42] }, { route: "booking" })],
    ["a timestamp is not ISO-8601", () => rig.api.inject({ kind: "bad-timestamp", field: "data.updatedAt", value: "yesterday" }, { route: "booking" })],
    ["a record claims to be updated in the future", () => rig.api.inject({ kind: "bad-timestamp", field: "data.updatedAt", value: "2027-01-01T00:00:00Z" }, { route: "booking" })],
    ["the response is for a different booking", () => rig.api.inject({ kind: "wrong-booking" }, { route: "booking" })],
    ["the body is not JSON", () => rig.api.inject({ kind: "malformed-json" }, { route: "booking" })],
    ["asOf is missing", () => rig.api.inject({ kind: "drop-field", field: "asOf" }, { route: "booking" })],
  ];
  for (const [name, inject] of cases) {
    it(name, async () => {
      inject();
      await expect(rig.connector.getBooking(scopeFor(), contextFor(), "BK1001")).rejects.toMatchObject({ category: "malformed_response", info: { attempts: 1, stopped: "not_retryable" } });
      expect(rig.api.log).toHaveLength(1);
      expect(rig.sleeps).toEqual([]);
    });
  }

  it("a container page with a negative weight or a repeated container is rejected", async () => {
    rig.api.inject({ kind: "wrong-type", field: "data.items", value: [{ containerNo: "X1", weightKg: -5 }], }, { route: "containers", page: 1 });
    const listing = await rig.connector.listContainers(scopeFor(), contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing).toMatchObject({ complete: false, items: [], incomplete: { kind: "failure", category: "malformed_response", atPage: 1 } });
    rig.api.inject({ kind: "wrong-type", field: "data.items", value: [{ containerNo: "X1", weightKg: 1 }, { containerNo: "X1", weightKg: 2 }] }, { route: "containers", page: 1 });
    expect(await rig.connector.listContainers(scopeFor(), contextFor(), "BK1001", BK1001_CONTAINERS)).toMatchObject({ complete: false, incomplete: { category: "malformed_response" } });
  });
});

describe("pagination and completeness", () => {
  it("a repeated cursor stops the listing as a pagination error instead of looping", async () => {
    rig.api.inject({ kind: "repeat-cursor" }, { route: "containers", page: 2 });
    const listing = await rig.connector.listContainers(scopeFor(), contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing.complete).toBe(false);
    expect(listing.incomplete).toMatchObject({ kind: "failure", category: "pagination_error" });
    expect(rig.api.requestsFor("containers")).toHaveLength(2);
  });

  it("an endless listing is cut off at the per-lookup page limit", async () => {
    await rig.close();
    rig = await startConnector({ maxPagesPerLookup: 4 });
    rig.api.inject({ kind: "endless-pages" }, { route: "containers" }, Infinity);
    const listing = await rig.connector.listContainers(scopeFor(), contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing).toMatchObject({ complete: false, pagesFetched: 4, incomplete: { kind: "page_limit", limit: 4 } });
    expect(rig.api.requestsFor("containers")).toHaveLength(4);
  });

  it("a listing missing a container the booking names is incomplete, not a smaller total", async () => {
    rig.api.inject({ kind: "container-mismatch", mode: "extra" }, { route: "booking" });
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    if (outcome.kind !== "found") throw new Error("expected found");
    expect(outcome.containers).toMatchObject({
      complete: false,
      expected: 6,
      totalWeightKg: null,
      retrievedWeightKg: 52250,
      incomplete: { kind: "identity_mismatch", expected: 6, received: 5, missing: ["GHOST0000001"], unexpected: [] },
    });
  });

  it("a SWAPPED container is caught although the count still matches, and the foreign container adds no weight", async () => {
    rig.api.inject({ kind: "container-mismatch", mode: "swap" }, { route: "booking" });
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    if (outcome.kind !== "found") throw new Error("expected found");
    // Five containers named, five returned: only the identities reveal the substitution.
    expect(outcome.containers.expected).toBe(5);
    expect(outcome.containers.retrieved).toHaveLength(4);
    expect(outcome.containers).toMatchObject({ complete: false, totalWeightKg: null, retrievedWeightKg: 12000 + 11500 + 9800 + 10250, incomplete: { kind: "identity_mismatch", missing: ["GHOST0000001"], unexpected: ["MSKU0000005"] } });
  });

  it("a container that is not the booking's contributes nothing on ANY incomplete path, not only on an identity mismatch", async () => {
    // Page 1 carries a foreign container; page 2 then fails for good, so the listing never reaches the identity check.
    rig.api.inject({ kind: "foreign-container" }, { route: "containers", page: 1 });
    rig.api.inject({ kind: "status", status: 503 }, { route: "containers", page: 2 }, Infinity);
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    if (outcome.kind !== "found") throw new Error("expected found");
    expect(outcome.containers.incomplete).toMatchObject({ kind: "failure", category: "unavailable", atPage: 2 });
    expect(outcome.containers.retrieved.map((item) => item.containerNo)).toEqual(["MSKU0000002"]);
    expect(outcome.containers.retrievedWeightKg).toBe(11500); // not 99999 + 11500
    expect(outcome.containers.totalWeightKg).toBeNull();
  });

  it("the same holds when the page budget ends the listing", async () => {
    rig.api.inject({ kind: "foreign-container" }, { route: "containers", page: 1 });
    const budget = new RunBudget({ ...DEFAULT_LIMITS, maxPages: 1 });
    const listing = await rig.connector.listContainers(scopeFor({ budget }), contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing).toMatchObject({ complete: false, pagesFetched: 1, incomplete: { kind: "budget", dimension: "pages", atPage: 2 } });
    expect(listing.items.map((item) => item.containerNo)).toEqual(["MSKU0000002"]);
  });

  it("a booking has at least one container: a record with none is malformed, never an empty 'complete' listing", async () => {
    rig.api.inject({ kind: "wrong-type", field: "data.containerNos", value: [] }, { route: "booking" });
    await expect(service().lookup(scopeFor(), contextFor(), "BK1001")).rejects.toMatchObject({ category: "malformed_response" });
    expect(rig.api.requestsFor("containers")).toHaveLength(0);
  });

  it("a page that fails for good after the first one leaves a partial listing with no total", async () => {
    rig.api.inject({ kind: "status", status: 503 }, { route: "containers", page: 2 }, Infinity);
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    if (outcome.kind !== "found") throw new Error("expected found");
    expect(outcome.containers).toMatchObject({
      complete: false,
      totalWeightKg: null,
      retrievedWeightKg: 12000 + 11500,
      pagesFetched: 1,
      incomplete: { kind: "failure", category: "unavailable", atPage: 2 },
    });
  });

  it("containers repeated across pages are not counted twice: the listing is incomplete, never a doubled total", async () => {
    // Page 2 re-serves page 1's containers under an advancing cursor; the count and cursor checks alone would not notice.
    rig.api.inject({ kind: "replay-first-page" }, { route: "containers", page: 2 });
    const outcome = await service().lookup(scopeFor(), contextFor(), "BK1001");
    if (outcome.kind !== "found") throw new Error("expected found");
    expect(outcome.containers).toMatchObject({ complete: false, totalWeightKg: null, retrievedWeightKg: 12000 + 11500, incomplete: { kind: "failure", category: "pagination_error", atPage: 2 } });
  });
});

describe("response size limit", () => {
  it("a chunked body with no Content-Length is cut off at the limit and rejected, not buffered whole or retried", async () => {
    await rig.close();
    rig = await startConnector({ maxResponseBytes: 2_048 });
    rig.api.inject({ kind: "oversize-body", bytes: 200_000 }, { route: "booking" });
    await expect(rig.connector.getBooking(scopeFor(), contextFor(), "BK1001")).rejects.toMatchObject({ category: "malformed_response", info: { attempts: 1, stopped: "not_retryable" } });
    expect(rig.api.log).toHaveLength(1);
  });

  it("the connector stops READING at the limit: the server is cut off long before it finishes a 20 MB body", async () => {
    await rig.close();
    rig = await startConnector({ maxResponseBytes: 2_048 });
    rig.api.inject({ kind: "oversize-body", bytes: 20_000_000 }, { route: "booking" });
    await expect(rig.connector.getBooking(scopeFor(), contextFor(), "BK1001")).rejects.toMatchObject({ category: "malformed_response" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rig.api.log[0]?.bytesWritten).toBeLessThan(500_000);
  });
});

describe("correlation", () => {
  it("every attempt carries the request, tool-call, operation, and attempt identity to the API, and the trace matches", async () => {
    const trace = new AttemptTrace();
    await service().lookup(scopeFor({ trace, toolCallId: "tc-77" }), contextFor(), "BK1001");
    expect(trace.records.map((record) => record.opId)).toEqual(["tc-77:booking:1", "tc-77:containers:1", "tc-77:containers:2", "tc-77:containers:3"]);
    expect(rig.api.log.map((entry) => [entry.requestId, entry.toolCallId, entry.opId, entry.attempt])).toEqual(trace.records.map((record) => [record.requestId, record.toolCallId, record.opId, record.attempt]));
    expect(trace.records.every((record) => record.outcome === "ok")).toBe(true);
  });
});
