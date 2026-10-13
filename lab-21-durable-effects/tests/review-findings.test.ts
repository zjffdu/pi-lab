import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Checkpoints } from "../src/checkpoints.js";
import { buildEffectReport } from "../src/report.js";
import { CONTRACTS, Rig, SECOND, bob, booking, receiverEffects, refusedUrl } from "./db-helpers.js";

/** Regression tests for defects found by the independent review of this lab. */
let rig: Rig;
beforeAll(async () => {
  rig = await Rig.start();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  await rig.reset();
});

const LEASE = 30 * SECOND;
const DROP = { at: "receiver.after_apply", action: { kind: "drop" } } as const;

describe("`failed` means known-not-to-have-happened", () => {
  it("attempt cap reached by a refused connection AFTER an earlier ambiguous attempt goes to manual review, not failed", async () => {
    await rig.reset(CONTRACTS.keyOnly, [DROP]);
    const { row, action } = await rig.admitted();
    // Attempt 1: the receiver applies it and the response is lost.
    const first = rig.worker("w1", { maxDeliveryAttempts: 2 });
    expect(await first.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60 * SECOND);
    expect(await first.runOnce()).toMatchObject({ result: "reconciled_resend" }); // keyOnly: idempotent, no lookup
    // Attempt 2 (the cap): the receiver is now unreachable.
    const second = rig.worker("w2", { maxDeliveryAttempts: 2, baseUrl: await refusedUrl() });
    expect(await second.runOnce()).toMatchObject({ result: "manual_review" });

    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "retries_exhausted_after_unresolved_attempt" });
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1); // it did happen
    expect(await buildEffectReport(rig.pool, rig.receiverPool, action.id)).toMatchObject({ consistent: true });
  });

  it("a receiver that reports key reuse with a different request is not taken as an ordinary refusal", async () => {
    const { row } = await rig.admitted();
    await rig.receiverPool.query("INSERT INTO receiver_keys (idempotency_key, request_hash, outcome, response, created_at) VALUES ($1, 'someone-elses-hash', 'applied', $2, now())", [
      row.idempotencyKey,
      JSON.stringify({ result: "applied", replayed: false, effectId: 1, bookingNo: "BK9", newStatus: "cancelled", toVersion: 2 }),
    ]);
    expect(await rig.worker("w1").runOnce()).toMatchObject({ result: "manual_review" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "receiver_reports_key_reuse_with_different_request" });
  });
});

describe("reconciliation reads the receiver's record faithfully", () => {
  it("a lookup that reports more than one effect for the key is not recorded as a clean success", async () => {
    await rig.reset(CONTRACTS.lookupOnly, [DROP]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    // A second, out-of-band delivery of the same request: this legacy receiver applies it again.
    await fetch(`${rig.receiver.url}/v1/status-changes`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": row.idempotencyKey },
      body: JSON.stringify({ tenantId: "tenant-a", bookingNo: "BK1001", newStatus: "on_hold", expectedVersion: 1 }),
    });
    rig.clock.advance(60 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "manual_review" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "receiver_reports_multiple_effects_for_this_key" });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });

  it("the receiver remembers a definitive refusal, so a lost response to a 404 reconciles to failed", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [DROP]);
    await rig.receiverPool.query("DELETE FROM receiver_bookings WHERE tenant_id = 'tenant-a' AND booking_no = 'BK1001'");
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "failed" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "failed", lastError: "rejected_by_receiver" });
    expect((await rig.store.get(row.id))?.deliveryAttempts).toBe(1); // no pointless resends
  });
});

describe("manual review and bookkeeping", () => {
  const inReview = async () => {
    await rig.reset(CONTRACTS.neither, [DROP]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    await worker.runOnce();
    rig.clock.advance(60 * SECOND);
    await worker.runOnce();
    return row;
  };

  it("resolving does not roll the local booking view backwards, and says so in the audit event", async () => {
    const row = await inReview();
    await rig.pool.query("UPDATE bookings SET version = 5 WHERE tenant_id = 'tenant-a' AND booking_no = 'BK1001'");
    const resolved = await rig.review.resolve(bob(), row.id, { kind: "confirmed_applied", toVersion: 2, note: "checked downstream" });
    expect(resolved).toMatchObject({ ok: true, row: { status: "succeeded", result: { toVersion: 2 }, reviewReason: null } });
    expect((await booking(rig.pool, "tenant-a", "BK1001")).version).toBe(5);
    const event = (await rig.store.events(row.id)).find((entry) => entry.event === "manual_confirmed_applied");
    expect(event?.detail).toMatchObject({ localViewUpdated: false, reviewReason: "receiver_has_neither_idempotency_nor_lookup" });
  });

  it("a resolved row no longer carries the review reason that stopped it", async () => {
    const row = await inReview();
    expect(await rig.review.resolve(bob(), row.id, { kind: "confirmed_not_applied", note: "n" })).toMatchObject({ ok: true, row: { status: "failed", reviewReason: null } });
    const other = await inReview();
    const redelivered = await rig.review.resolve(bob(), other.id, { kind: "redeliver", note: "n", acceptDuplicateRisk: true });
    expect(redelivered).toMatchObject({ ok: true, row: { status: "pending", reviewReason: null } });
  });
});

describe("expired reconciliation leases are visible", () => {
  it("a worker that dies while holding a reconcile claim is recorded as a lease expiry and the row is recovered", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [DROP]);
    const { row } = await rig.admitted();
    expect(await rig.worker("w1").runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60 * SECOND);
    const crash = new Checkpoints([{ at: "worker.after_claim", action: { kind: "crash" }, match: { kind: "reconcile" } }]);
    await expect(rig.worker("w-dead", { checkpoints: crash, leaseMs: LEASE }).runOnce()).rejects.toThrow(/simulated crash/);
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", leaseOwner: "w-dead" });

    rig.clock.advance(LEASE + 1);
    expect(await rig.worker("w-rescue", { leaseMs: LEASE }).runOnce()).toMatchObject({ result: "succeeded" });
    const expiries = (await rig.store.events(row.id)).filter((entry) => entry.event === "lease_expired");
    expect(expiries).toHaveLength(1);
    expect(expiries[0]?.detail).toMatchObject({ during: "reconcile", previousOwner: "w-dead" });
  });
});
