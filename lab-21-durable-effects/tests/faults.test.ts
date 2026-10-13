import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Checkpoints, SimulatedCrash } from "../src/checkpoints.js";
import { buildEffectReport } from "../src/report.js";
import { CONTRACTS, Rig, SECOND, alice, booking, receiverBooking, receiverEffects, receiverRequests } from "./db-helpers.js";

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
const events = async (id: number) => (await rig.store.events(id)).map((entry) => entry.event);

/** A worker whose next hit of `at` crashes it — everything held in memory is gone, the database stays as-is. */
const crashingWorker = (id: string, at: "worker.after_claim" | "worker.before_send" | "worker.after_response" | "worker.before_result_commit") =>
  rig.worker(id, { checkpoints: new Checkpoints([{ at, action: { kind: "crash" } }]), leaseMs: LEASE });

describe("failure injections at named checkpoints (receiver: idempotent by key, has lookup)", () => {
  it("crash before send: no request left the worker; the expired lease is reconciled (no record) and the resend makes one effect", async () => {
    const { row, action } = await rig.admitted();
    await expect(crashingWorker("w-crash", "worker.after_claim").runOnce()).rejects.toBeInstanceOf(SimulatedCrash);

    expect(await rig.store.get(row.id)).toMatchObject({ status: "in_flight", leaseOwner: "w-crash", deliveryAttempts: 1 });
    expect(await receiverRequests(rig.receiverPool, "deliver")).toBe(0);

    // While the lease is live, nobody else may take the row.
    const rescuer = rig.worker("w-rescue", { leaseMs: LEASE });
    expect(await rescuer.runOnce()).toEqual({ kind: "idle" });

    rig.clock.advance(LEASE + 1);
    expect(await rescuer.runOnce()).toMatchObject({ result: "reconciled_resend" });
    expect(await rescuer.runOnce()).toMatchObject({ result: "succeeded" });

    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await events(row.id)).toEqual(expect.arrayContaining(["lease_expired", "claimed_reconcile", "reconciled_resend", "succeeded"]));
    expect(await buildEffectReport(rig.pool, rig.receiverPool, action.id)).toMatchObject({ consistent: true, attempts: { deliveryClaims: 2, reconcileClaims: 1, leaseExpiries: 1 } });
  });

  it("response lost after the receiver succeeded: unknown is not shown as success, and reconciliation finds the effect without resending", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { row, action } = await rig.admitted();
    const worker = rig.worker("w1");

    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    // The receiver has applied the change, but the application must not claim so — and must not claim failure.
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", result: null });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
    expect((await rig.service.get(alice(), action.id))?.action.delivery?.status).toBe("unknown");

    // Reconciliation is not claimable until its backoff has passed.
    expect(await worker.runOnce()).toEqual({ kind: "idle" });
    rig.clock.advance(5 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "succeeded" });

    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", result: { source: "reconciliation", toVersion: 2 } });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    // One delivery request ever reached the receiver: the lookup replaced a resend.
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(1);
    expect(await receiverRequests(rig.receiverPool, "lookup", row.idempotencyKey)).toBe(1);
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
  });

  it("applied, then a 503: the effect exists although the status was an error", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.after_apply", action: { kind: "http", status: 503 } }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", lastError: "http_503" });
    rig.clock.advance(5 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "succeeded" });
    expect(await receiverEffects(rig.receiverPool)).toBe(1);
  });

  it("crash after the receiver succeeded but before the local result commit: recovered by reconciliation, still one effect", async () => {
    const { row, action } = await rig.admitted();
    await expect(crashingWorker("w-crash", "worker.before_result_commit").runOnce()).rejects.toBeInstanceOf(SimulatedCrash);

    // The receiver applied it; the application's durable record says nothing happened yet.
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await rig.store.get(row.id)).toMatchObject({ status: "in_flight", result: null });
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });

    rig.clock.advance(LEASE + 1);
    const rescuer = rig.worker("w-rescue", { leaseMs: LEASE });
    expect(await rescuer.runOnce()).toMatchObject({ result: "succeeded" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", result: { source: "reconciliation" } });
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(1);
    expect(await buildEffectReport(rig.pool, rig.receiverPool, action.id)).toMatchObject({ consistent: true, businessEffects: { appliedCount: 1 } });
  });

  it("crash after the local result commit leaves nothing to recover", async () => {
    const { row } = await rig.admitted();
    const cps = new Checkpoints([{ at: "worker.after_result_commit", action: { kind: "crash" } }]);
    await expect(rig.worker("w-crash", { checkpoints: cps }).runOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded" });
    rig.clock.advance(LEASE * 10);
    expect(await rig.worker("w2").runOnce()).toEqual({ kind: "idle" });
    expect(await receiverEffects(rig.receiverPool)).toBe(1);
  });

  it("crash after the response arrives but before anything is recorded is the same as a lost response", async () => {
    const { row } = await rig.admitted();
    await expect(crashingWorker("w-crash", "worker.after_response").runOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    rig.clock.advance(LEASE + 1);
    expect(await rig.worker("w2").runOnce()).toMatchObject({ result: "succeeded" });
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
  });

  it("receiver fails before applying: the failure is ambiguous, lookup finds no record, the resend applies once", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.before_apply", action: { kind: "http", status: 503 } }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");

    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(5 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "reconciled_resend" });
    expect(await worker.runOnce()).toMatchObject({ result: "succeeded" });

    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    // Two requests arrived (the one answered with an injected 503, then the resend); only one became an effect.
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(2);
    expect((await rig.store.get(row.id))?.deliveryAttempts).toBe(2);
  });

  it("every named checkpoint is reachable", async () => {
    await rig.reset(CONTRACTS.keyAndLookup);
    const cps = new Checkpoints();
    await rig.admitted();
    await rig.worker("w1", { checkpoints: cps }).runUntilIdle();
    for (const name of ["worker.after_claim", "worker.before_send", "worker.after_response", "worker.before_result_commit", "worker.after_result_commit"] as const) {
      expect(cps.hitCount(name), name).toBeGreaterThan(0);
    }
    expect(rig.receiverCheckpoints.hitCount("receiver.before_apply")).toBe(1);
    expect(rig.receiverCheckpoints.hitCount("receiver.after_apply")).toBe(1);
  });
});

describe("a timeout does not prove the effect did not happen", () => {
  // The receiver is slow (1200 ms); the worker gives up at 400 ms. The margins are wide on purpose: the resend and the
  // lookup must each finish well inside the timeout even when the machine is busy.
  const SLOW = { at: "receiver.before_apply", action: { kind: "delay", ms: 1200 } } as const;

  it("idempotent receiver: lookup says 'no record' while the original is still in flight; the resend is safe because the key deduplicates", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [SLOW]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1", { timeoutMs: 400 });

    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    expect((await rig.store.get(row.id))?.lastError).toBe("timeout");
    // The worker gave up waiting, but the receiver has not applied anything *yet*.
    expect(await receiverEffects(rig.receiverPool)).toBe(0);

    rig.clock.advance(5 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "reconciled_resend" }); // "not_found" right now...
    expect(await receiverEffects(rig.receiverPool)).toBe(0);

    // ...yet the original request lands afterwards. The resend and the original share one key.
    expect(await worker.runOnce()).toMatchObject({ result: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(2); // two arrived, one effect
  });

  it("receiver without idempotency: 'no record' is not enough to resend — the row waits for a person, and the original then lands", async () => {
    await rig.reset(CONTRACTS.lookupOnly, [SLOW]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1", { timeoutMs: 400 });

    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(5 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "manual_review" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "no_receiver_record_but_original_request_may_still_arrive" });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The effect the timeout suggested was absent did happen — and a blind resend would have doubled it.
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(1);
  });
});
