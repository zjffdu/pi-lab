import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildEffectReport } from "../src/report.js";
import { CONTRACTS, Rig, SECOND, alice, bob, booking, carol, dave, erin, frank, must, receiverBooking, receiverEffects } from "./db-helpers.js";

let rig: Rig;
beforeAll(async () => {
  rig = await Rig.start();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  // A legacy receiver that applied the change but lost the response: the application cannot know, so it asks a person.
  await rig.reset(CONTRACTS.neither, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
});

async function inReview() {
  const { row, action } = await rig.admitted();
  const worker = rig.worker("w1");
  await worker.runOnce();
  rig.clock.advance(60 * SECOND);
  await worker.runOnce();
  expect((await rig.store.get(row.id))?.status).toBe("manual_review");
  return { row, action };
}

describe("manual review of an unresolved outcome (receiver: no idempotency, no lookup)", () => {
  it("is listed for approvers of the tenant only", async () => {
    await inReview();
    expect(await rig.review.list(bob())).toHaveLength(1);
    expect(await rig.review.list(alice())).toEqual([]); // operators do not review
    expect(await rig.review.list(carol())).toEqual([]);
    expect(await rig.review.list(frank())).toEqual([]); // another tenant's approver sees nothing
  });

  it("'confirmed applied' records the result, updates the local view, and leaves an audit trail", async () => {
    const { row, action } = await inReview();
    const resolved = await rig.review.resolve(bob(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "checked the booking system: BK1001 is on_hold v2" });
    expect(resolved).toMatchObject({ ok: true, row: { status: "succeeded", result: { source: "manual_review", toVersion: 2 } } });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    const trail = (await rig.store.events(row.id)).find((event) => event.event === "manual_confirmed_applied");
    expect(trail?.detail).toMatchObject({ by: "bob", reviewReason: "receiver_has_neither_idempotency_nor_lookup" });
    expect(await buildEffectReport(rig.pool, rig.receiverPool, action.id)).toMatchObject({ consistent: true, businessEffects: { appliedCount: 1 } });
  });

  it("'confirmed not applied' fails the row and leaves the local view alone", async () => {
    const { row } = await inReview();
    // (In this receiver the effect did happen; the point here is that the *resolution* is the person's, recorded as such.)
    const resolved = await rig.review.resolve(bob(), row.id, { kind: "confirmed_not_applied", note: "operator says no change visible" });
    expect(resolved).toMatchObject({ ok: true, row: { status: "failed", lastError: "manual_confirmed_not_applied" } });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });

  it("redeliver needs an explicit acceptance of duplicate risk, and then really can double the effect on this receiver", async () => {
    const { row } = await inReview();
    expect(await rig.review.resolve(bob(), row.id, { kind: "redeliver", note: "try again", acceptDuplicateRisk: false })).toEqual({ ok: false, code: "risk_not_accepted" });
    expect((await rig.store.get(row.id))?.status).toBe("manual_review");

    expect(await rig.review.resolve(bob(), row.id, { kind: "redeliver", note: "accepting the risk", acceptDuplicateRisk: true })).toMatchObject({ ok: true, row: { status: "pending" } });
    await rig.worker("w2").runUntilIdle();
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(2);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 3 });
  });

  it("requires a note, an approver, someone other than the requester, and the right tenant", async () => {
    const { row } = await inReview();
    expect(await rig.review.resolve(bob(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "  " })).toEqual({ ok: false, code: "note_required" });
    expect(await rig.review.resolve(alice(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "forbidden" });
    expect(await rig.review.resolve(carol(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "forbidden" });
    expect(await rig.review.resolve(frank(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "not_found" });
    expect((await rig.store.get(row.id))?.status).toBe("manual_review");

    // dave proposed a change himself: an approver, but not allowed to decide on his own request.
    await rig.reset(CONTRACTS.neither, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const proposal = must(await rig.service.propose(dave(), { bookingNo: "BK1001", newStatus: "on_hold", reason: "x" }));
    must(await rig.service.approve(bob(), proposal.id, { digest: proposal.digest }));
    const admitted = must(await rig.service.admit(dave(), proposal.id));
    const worker = rig.worker("w1");
    await worker.runOnce();
    rig.clock.advance(60 * SECOND);
    await worker.runOnce();
    const outboxId = admitted.delivery?.outboxId ?? 0;
    expect(await rig.review.resolve(dave(), outboxId, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "self_resolution" });
    expect(await rig.review.resolve(bob(), outboxId, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toMatchObject({ ok: true });
  });

  it("only a row in manual_review can be resolved", async () => {
    const { row } = await rig.admitted();
    expect(await rig.review.resolve(bob(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "not_in_review" });
    expect(await rig.review.resolve(erin(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" })).toEqual({ ok: false, code: "not_found" });
  });

  it("succeeded and failed are terminal even for the database", async () => {
    const { row } = await inReview();
    await rig.review.resolve(bob(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "n" });
    await expect(rig.pool.query("UPDATE outbox SET status = 'pending' WHERE id = $1", [row.id])).rejects.toThrow(/terminal/);
  });
});
