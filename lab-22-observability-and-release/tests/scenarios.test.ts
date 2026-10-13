import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAllCases } from "../src/case-registry.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { checkInvariants } from "../src/invariants.js";
import { ApprovalStore, Pipeline, ReceiverLedger } from "../src/pipeline.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

/**
 * Runs every joint-acceptance and dev scenario against the synthetic pipeline and checks the
 * result against the case fixture's own declared expectation and invariants — the same contract
 * `scripts/run-cases.ts` checks, asserted here so `npm run check` covers it.
 */
describe("joint acceptance scenarios (via case fixtures)", () => {
  const fixture = loadTenantFixture();

  for (const kase of loadAllCases()) {
    it(`${kase.id}: ${kase.description}`, () => {
      const directory = new PrincipalDirectory(fixture.principals);
      const approvals = new ApprovalStore(join(mkdtempSync(join(tmpdir(), "pi-lab-22-")), "approvals.json"));
      const ledger = new ReceiverLedger();
      const pipeline = new Pipeline({ directory, bookings: fixture.bookings, approvals, ledger });
      const context = mintSecurityContextForTest({ tenantId: kase.tenantId, subject: kase.subject, requestId: `req-${kase.id}` });

      const result = pipeline.run(kase, context);
      expect(result.outcome).toBe(kase.expected.outcome);

      const invariantResults = checkInvariants({ kase, result, bookings: fixture.bookings, ledger });
      for (const invariant of invariantResults) expect.soft(invariant.holds, invariant.detail).toBe(true);

      const presentStages = new Set(result.spans.map((span) => span.stage));
      for (const stage of kase.expected.reachedStages) expect.soft(presentStages.has(stage), `expected stage "${stage}" to have a span`).toBe(true);
    });
  }
});

describe("restart-during-approval: a pending approval survives a fresh Pipeline instance on the same store", () => {
  it("keeps the pending record bound to the same action id after a simulated restart", () => {
    const fixture = loadTenantFixture();
    const [kase] = loadAllCases().filter((entry) => entry.id === "held-restart-during-approval");
    if (!kase) throw new Error("expected held-restart-during-approval fixture");

    const storePath = join(mkdtempSync(join(tmpdir(), "pi-lab-22-restart-")), "approvals.json");
    const directory1 = new PrincipalDirectory(fixture.principals);
    const pipeline1 = new Pipeline({ directory: directory1, bookings: fixture.bookings, approvals: new ApprovalStore(storePath), ledger: new ReceiverLedger() });
    const context = mintSecurityContextForTest({ tenantId: kase.tenantId, subject: kase.subject, requestId: "req-restart" });
    const result1 = pipeline1.run(kase, context);
    expect(result1.outcome).toBe("pending_approval");

    const actionId = `action-${kase.id}`;
    const before = pipeline1.approvals.get(actionId);
    expect(before?.status).toBe("pending");

    // A fresh Pipeline/ApprovalStore pair pointed at the same file simulates a process restart.
    const directory2 = new PrincipalDirectory(fixture.principals);
    const pipeline2 = new Pipeline({ directory: directory2, bookings: fixture.bookings, approvals: new ApprovalStore(storePath), ledger: new ReceiverLedger() });
    const after = pipeline2.approvals.get(actionId);
    expect(after).toEqual(before);
  });
});

describe("double-approve: only one of two concurrent decisions admits", () => {
  it("rejects the second decide() call for the same action", () => {
    const store = new ApprovalStore(join(mkdtempSync(join(tmpdir(), "pi-lab-22-double-")), "approvals.json"));
    store.create({ actionId: "action-x", tenantId: "tenant-a", requester: "dave", bookingNo: "BK1001", status: "pending" });
    expect(store.decide("action-x", "bob")).toBe("ok");
    expect(store.decide("action-x", "bob")).toBe("already_decided");
  });
});
