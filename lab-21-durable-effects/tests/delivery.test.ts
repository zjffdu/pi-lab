import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildEffectReport } from "../src/report.js";
import { CONTRACTS, Rig, booking, receiverBooking, receiverEffects, receiverRequests, refusedUrl } from "./db-helpers.js";

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

describe("delivery of an admitted action (receiver: idempotent by key, has lookup)", () => {
  it("admission alone creates no business effect and sends nothing", async () => {
    const { row } = await rig.admitted();
    expect(row.status).toBe("pending");
    expect(await receiverEffects(rig.receiverPool)).toBe(0);
    expect(await receiverRequests(rig.receiverPool, "deliver")).toBe(0);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });

  it("delivers once: one effect at the receiver, and a durable result plus local view recorded together", async () => {
    const { action, row } = await rig.admitted();
    const step = await rig.worker("w1").runOnce();
    expect(step).toMatchObject({ kind: "worked", result: "succeeded" });

    const settled = await rig.store.get(row.id);
    expect(settled).toMatchObject({ status: "succeeded", deliveryAttempts: 1, leaseOwner: null });
    expect(settled?.result).toMatchObject({ source: "delivery", newStatus: "on_hold", toVersion: 2, replayed: false });
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });

    const report = await buildEffectReport(rig.pool, rig.receiverPool, action.id);
    expect(report).toMatchObject({ consistent: true, businessEffects: { appliedCount: 1 }, attempts: { deliveryClaims: 1, receiverSawRequests: 1 } });
  });

  it("does nothing when there is nothing to deliver", async () => {
    expect(await rig.worker("w1").runOnce()).toEqual({ kind: "idle" });
  });

  it("presents the same idempotency key on every attempt, and it is a pure function of the action", async () => {
    const { row } = await rig.admitted();
    const observed: string[] = [];
    // A worker that never gets an answer (its receiver is closed) still uses the row's key each time.
    const dead = rig.worker("w-dead", { baseUrl: await refusedUrl(), maxDeliveryAttempts: 3 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const step = await dead.runOnce();
      expect(step.kind).toBe("worked");
      const current = await rig.store.get(row.id);
      observed.push(current?.idempotencyKey ?? "");
      rig.clock.advance(60_000);
    }
    // A different worker — a "restart" — then delivers it, still under that key.
    await rig.worker("w-restarted").runUntilIdle();
    expect(new Set(observed)).toEqual(new Set([row.idempotencyKey]));
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    const events = await rig.store.events(row.id);
    expect(events.filter((event) => event.event === "claimed_deliver")).toHaveLength(3);
  });

  it("a duplicate delivery of the same key creates no second effect", async () => {
    const { row } = await rig.admitted();
    await rig.worker("w1").runOnce();
    // Send the same request again out-of-band, as a confused retry would.
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const response = await fetch(`${rig.receiver.url}/v1/status-changes`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": row.idempotencyKey, "x-fencing-token": "9" },
        body: JSON.stringify({ tenantId: "tenant-a", bookingNo: "BK1001", newStatus: "on_hold", expectedVersion: 1 }),
      });
      expect(await response.json()).toMatchObject({ result: "applied", replayed: true, toVersion: 2 });
    }
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
  });

  it("the same key with different content is refused, not applied", async () => {
    const { row } = await rig.admitted();
    await rig.worker("w1").runOnce();
    const response = await fetch(`${rig.receiver.url}/v1/status-changes`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": row.idempotencyKey },
      body: JSON.stringify({ tenantId: "tenant-a", bookingNo: "BK1001", newStatus: "cancelled", expectedVersion: 1 }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ result: "rejected", code: "idempotency_key_reuse" });
    expect(await receiverEffects(rig.receiverPool)).toBe(1);
  });

  it("a receiver refusal is definitive: the row fails, and it is not retried", async () => {
    // Two actions approved against the same version; the receiver's version precondition lets only one win.
    const first = await rig.admitted("BK1001", "on_hold");
    const second = await rig.admitted("BK1001", "cancelled");
    const worker = rig.worker("w1");
    await worker.runUntilIdle();

    const a = await rig.store.get(first.row.id);
    const b = await rig.store.get(second.row.id);
    expect([a?.status, b?.status].sort()).toEqual(["failed", "succeeded"]);
    const loser = a?.status === "failed" ? a : b;
    expect(loser).toMatchObject({ lastError: "rejected_by_receiver", deliveryAttempts: 1 });
    expect(await receiverEffects(rig.receiverPool)).toBe(1);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001").then((value) => value.version)).toBe(2);
  });

  it("connection refused proves nothing was sent: it backs off and retries, then dead-letters as failed", async () => {
    const { row } = await rig.admitted();
    const dead = rig.worker("w1", { baseUrl: await refusedUrl(), maxDeliveryAttempts: 2 });

    expect(await dead.runOnce()).toMatchObject({ result: "retry_scheduled" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "pending", lastError: "connection_refused", deliveryAttempts: 1 });
    // Backoff: not claimable again until its delay has passed.
    expect(await dead.runOnce()).toEqual({ kind: "idle" });
    rig.clock.advance(5_000);
    expect(await dead.runOnce()).toMatchObject({ result: "failed" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "failed", lastError: "retries_exhausted", deliveryAttempts: 2 });
    expect(await receiverEffects(rig.receiverPool)).toBe(0);
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });

  it("tenants stay separate: the same BK1001 in the other tenant is untouched", async () => {
    await rig.admitted("BK1001", "on_hold", "a");
    await rig.worker("w1").runUntilIdle();
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    expect(await receiverBooking(rig.receiverPool, "tenant-b", "BK1001")).toEqual({ status: "booked", version: 1 });
  });
});

describe("contract assumptions are configuration, not discovery", () => {
  it("assumed idempotent but the receiver is not: the reconciliation resend applies the action twice", async () => {
    // The first response is lost after the receiver applied the change. The application *assumes* a
    // receiver that deduplicates by key and has no lookup, so reconciliation resends under the same key.
    await rig.reset(CONTRACTS.lookupOnly, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { action, row } = await rig.admitted();
    const worker = rig.worker("w1", { assumes: CONTRACTS.keyOnly });

    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60_000);
    expect(await worker.runOnce()).toMatchObject({ result: "reconciled_resend" });
    expect(await worker.runOnce()).toMatchObject({ result: "succeeded" });

    // The real receiver ignores keys, so the "safe" resend was a second business effect.
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(2);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 3 });
    const report = await buildEffectReport(rig.pool, rig.receiverPool, action.id);
    expect(report).toMatchObject({ consistent: false, inconsistency: expect.stringContaining("duplicate business effect") });
  });
});
