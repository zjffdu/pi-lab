import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Checkpoints, type Fault } from "../src/checkpoints.js";
import type { ReceiverContract } from "../src/receiver/contract.js";
import { CONTRACTS, Rig, SECOND, receiverBooking, receiverEffects, receiverRequests } from "./db-helpers.js";

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
const bookingNos = (n: number) => Array.from({ length: n }, (_, index) => `BK30${String(index + 1).padStart(2, "0")}`);

describe("concurrent claims (in one process, separate workers)", () => {
  it("each outbox row is claimed by exactly one worker and produces exactly one effect", async () => {
    // A slow receiver makes the workers overlap instead of one finishing before the others start.
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.before_apply", action: { kind: "delay", ms: 40 }, times: 12 }]);
    const rows = [];
    for (const bookingNo of bookingNos(12)) rows.push((await rig.admitted(bookingNo)).row);

    const workers = ["w1", "w2", "w3", "w4"].map((id) => rig.worker(id));
    const done = await Promise.all(workers.map((worker) => worker.runUntilIdle()));
    expect(done.reduce((sum, value) => sum + value, 0)).toBe(12);
    expect(done.filter((value) => value > 0).length).toBeGreaterThan(1); // more than one worker really took part

    for (const row of rows) {
      const claims = (await rig.store.events(row.id)).filter((entry) => entry.event === "claimed_deliver");
      expect(claims, row.bookingNo).toHaveLength(1);
      expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", deliveryAttempts: 1 });
      expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    }
    expect(await receiverEffects(rig.receiverPool)).toBe(12);
  });
});

/**
 * Starts one step of `worker` and returns once it is paused at `name`. The step's promise is wrapped
 * in an object on purpose: returning the bare promise from an async function would make the caller's
 * `await` wait for the (still paused) step to finish.
 */
async function stall(worker: ReturnType<Rig["worker"]>, cps: Checkpoints, name: Fault["at"]) {
  const finished = worker.runOnce();
  await cps.waitUntilPaused(name);
  return { finished };
}

describe("lease expiry and a stale worker that comes back", () => {
  it("stalled after the receiver applied: a newer worker reconciles; the old worker's late result is discarded and recorded", async () => {
    const { row } = await rig.admitted();
    const cpsA = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "pause" } }]);
    const a = rig.worker("A", { checkpoints: cpsA, leaseMs: LEASE });
    const { finished: stalledA } = await stall(a, cpsA, "worker.before_result_commit");
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1); // A already got its answer

    rig.clock.advance(LEASE + 1);
    const b = rig.worker("B", { leaseMs: LEASE });
    expect(await b.runOnce()).toMatchObject({ result: "succeeded" });
    const winner = await rig.store.get(row.id);
    expect(winner).toMatchObject({ status: "succeeded", result: { source: "reconciliation" }, fencingToken: 2 });

    // A wakes up and tries to record "succeeded (delivery)". The fence turns it away; the row is unchanged.
    cpsA.release("worker.before_result_commit");
    expect(await stalledA).toMatchObject({ result: "discarded:succeeded" });
    expect(await rig.store.get(row.id)).toEqual(winner);
    expect(await events(row.id)).toContain("stale_write_rejected");
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
  });

  it("stalled before sending: the old worker's late request is deduplicated by the receiver, and its late result is discarded", async () => {
    const { row } = await rig.admitted();
    const cpsA = new Checkpoints([{ at: "worker.before_send", action: { kind: "pause" } }]);
    const a = rig.worker("A", { checkpoints: cpsA, leaseMs: LEASE });
    const { finished: stalledA } = await stall(a, cpsA, "worker.before_send");

    rig.clock.advance(LEASE + 1);
    const b = rig.worker("B", { leaseMs: LEASE });
    expect(await b.runOnce()).toMatchObject({ result: "reconciled_resend" });
    expect(await b.runOnce()).toMatchObject({ result: "succeeded" });
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);

    cpsA.release("worker.before_send"); // A now sends its (older) request
    expect(await stalledA).toMatchObject({ result: "discarded:succeeded" });
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(2); // two arrived, one effect
    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", result: { source: "delivery" } });
    expect(await events(row.id)).toContain("stale_write_rejected");
  });

  it("a restarted worker that reuses its ID is still fenced from its own earlier claim: only the token tells two reconcile claims apart", async () => {
    // First delivery: applied, response lost -> the row is `unknown`, waiting to be reconciled.
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { row } = await rig.admitted();
    expect(await rig.worker("first").runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60 * SECOND);

    // Worker "A" claims the reconciliation (token 2) and stalls.
    const cpsOld = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "pause" } }]);
    const { finished: oldRun } = await stall(rig.worker("A", { checkpoints: cpsOld, leaseMs: LEASE }), cpsOld, "worker.before_result_commit");
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", leaseOwner: "A", fencingToken: 2 });

    // Its lease expires; the same worker ID, restarted, claims the reconciliation again (token 3) and stalls too.
    rig.clock.advance(LEASE + 1);
    const cpsNew = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "pause" } }]);
    const { finished: newRun } = await stall(rig.worker("A", { checkpoints: cpsNew, leaseMs: LEASE }), cpsNew, "worker.before_result_commit");
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", leaseOwner: "A", fencingToken: 3 });

    // The old run wakes first. Kind, owner ("A") and status ("unknown") all match; only the token (2 vs 3) differs.
    cpsOld.release("worker.before_result_commit");
    expect(await oldRun).toMatchObject({ result: "discarded:succeeded" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "unknown", fencingToken: 3 });
    expect(await events(row.id)).toContain("stale_write_rejected");

    cpsNew.release("worker.before_result_commit");
    expect(await newRun).toMatchObject({ result: "succeeded" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", result: { source: "reconciliation" } });
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
  });

  it("an expired lease does not by itself stop the old worker: with no newer claim its result is still accepted", async () => {
    const { row } = await rig.admitted();
    const cpsA = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "pause" } }]);
    const a = rig.worker("A", { checkpoints: cpsA, leaseMs: LEASE });
    const { finished: stalledA } = await stall(a, cpsA, "worker.before_result_commit");

    rig.clock.advance(LEASE * 5); // long past expiry, but nobody has swept or claimed
    cpsA.release("worker.before_result_commit");
    expect(await stalledA).toMatchObject({ result: "succeeded" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded", fencingToken: 1 });
    expect(await events(row.id)).not.toContain("stale_write_rejected");
  });

  it("fencing token at the receiver's write boundary: a stale token is refused before anything is applied", async () => {
    await rig.reset(CONTRACTS.keyLookupFencing);
    const { row } = await rig.admitted();
    const cpsA = new Checkpoints([{ at: "worker.before_send", action: { kind: "pause" } }]);
    const a = rig.worker("A", { checkpoints: cpsA, leaseMs: LEASE });
    const { finished: stalledA } = await stall(a, cpsA, "worker.before_send");

    rig.clock.advance(LEASE + 1);
    const b = rig.worker("B", { leaseMs: LEASE });
    expect(await b.runOnce()).toMatchObject({ result: "reconciled_resend" });
    expect(await b.runOnce()).toMatchObject({ result: "succeeded" }); // B's delivery carries token 3
    cpsA.release("worker.before_send"); // A sends token 1

    expect(await stalledA).toMatchObject({ result: "stale_rejected_by_receiver" });
    expect(await events(row.id)).toContain("stale_rejected_by_receiver");
    expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    const logged = await rig.receiverPool.query<{ outcome: string }>("SELECT outcome FROM receiver_requests WHERE kind = 'deliver' ORDER BY id");
    expect(logged.rows.map((entry) => entry.outcome)).toEqual(["applied", "stale_fence"]);
  });

  it("fencing is not deduplication: a receiver that only checks tokens still applies the same request twice if the older token arrives first", async () => {
    await rig.reset(CONTRACTS.fencingOnly);
    const send = (token: number) =>
      fetch(`${rig.receiver.url}/v1/status-changes`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "k-1", "x-fencing-token": String(token) },
        body: JSON.stringify({ tenantId: "tenant-a", bookingNo: "BK1001", newStatus: "on_hold", expectedVersion: 1 }),
      }).then((response) => response.json());

    expect(await send(1)).toMatchObject({ result: "applied" });
    expect(await send(2)).toMatchObject({ result: "applied" }); // newer token: accepted, and applied again
    expect(await send(1)).toEqual({ result: "rejected", code: "stale_fence" }); // older token after a newer one: refused
    expect(await receiverEffects(rig.receiverPool, "k-1")).toBe(2);
    expect(await receiverBooking(rig.receiverPool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 3 });
  });
});

describe("bounded retries and the states a run can end in", () => {
  it("a receiver that never answers usefully: deliveries are bounded, the row ends in manual_review, nothing is displayed as success", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.before_apply", action: { kind: "http", status: 503 }, times: 100 }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1", { maxDeliveryAttempts: 3 });
    for (let round = 0; round < 12; round += 1) {
      await worker.runUntilIdle();
      rig.clock.advance(60 * SECOND);
    }
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "delivery_attempts_exhausted_outcome_unresolved", deliveryAttempts: 3 });
    expect(await receiverRequests(rig.receiverPool, "deliver")).toBe(3); // bounded: exactly the configured attempts
    expect(await receiverEffects(rig.receiverPool)).toBe(0);
  });

  it("receiver with neither idempotency nor lookup: a lost response goes to a person and is never resent", async () => {
    await rig.reset(CONTRACTS.neither, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    rig.clock.advance(60 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "manual_review" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "receiver_has_neither_idempotency_nor_lookup" });
    rig.clock.advance(60 * SECOND * 60);
    expect(await worker.runOnce()).toEqual({ kind: "idle" });
    expect(await receiverRequests(rig.receiverPool, "deliver")).toBe(1);
    expect(await receiverEffects(rig.receiverPool)).toBe(1); // it *was* applied; the application just cannot know
  });

  it("lookup unavailable: reconciliation retries, is bounded, then asks for review", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1", { maxReconcileAttempts: 2 });
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    await rig.receiver.close(); // the status interface is now unreachable
    for (let round = 0; round < 6; round += 1) {
      rig.clock.advance(60 * SECOND);
      await worker.runUntilIdle();
    }
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "reconciliation_exhausted", reconcileAttempts: 2 });
  });

  it("a lookup that disagrees with the request is not trusted", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.after_apply", action: { kind: "drop" } }]);
    const { row } = await rig.admitted();
    const worker = rig.worker("w1");
    expect(await worker.runOnce()).toMatchObject({ result: "outcome_unknown" });
    // Corrupt the receiver's record of what it did for this key.
    await rig.receiverPool.query("UPDATE receiver_keys SET response = jsonb_set(response, '{newStatus}', '\"cancelled\"') WHERE idempotency_key = $1", [row.idempotencyKey]);
    rig.clock.advance(60 * SECOND);
    expect(await worker.runOnce()).toMatchObject({ result: "manual_review" });
    expect(await rig.store.get(row.id)).toMatchObject({ status: "manual_review", reviewReason: "lookup_result_does_not_match_request" });
  });
});

describe("multiple delivery processes", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  interface Exit {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }
  const runChild = (id: string, extra: Record<string, string>, contract: ReceiverContract = CONTRACTS.keyAndLookup): Promise<Exit> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/worker-process.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: rig.env.url,
          APP_SCHEMA: rig.env.appSchema,
          RECEIVER_URL: rig.receiver.url,
          WORKER_ID: id,
          CONTRACT: JSON.stringify(contract),
          MAX_RUN_MS: "40000",
          ...extra,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

  it("two OS processes claim concurrently: no row is claimed twice, and every action has exactly one effect", async () => {
    await rig.reset(CONTRACTS.keyAndLookup, [{ at: "receiver.before_apply", action: { kind: "delay", ms: 120 }, times: 12 }]);
    const rows = [];
    for (const bookingNo of bookingNos(12)) rows.push((await rig.admitted(bookingNo)).row);

    const startAt = String(Date.now() + 4_000); // both processes wait for the same instant
    const [one, two] = await Promise.all([runChild("proc-1", { START_AT: startAt }), runChild("proc-2", { START_AT: startAt })]);
    expect([one.code, two.code], `${one.stderr}${two.stderr}`).toEqual([0, 0]);

    const claimedBy = new Map<string, string[]>();
    for (const row of rows) {
      const claims = (await rig.store.events(row.id)).filter((entry) => entry.event === "claimed_deliver");
      expect(claims, row.bookingNo).toHaveLength(1);
      claimedBy.set(row.bookingNo, claims.map((claim) => claim.workerId ?? ""));
      expect(await rig.store.get(row.id)).toMatchObject({ status: "succeeded" });
      expect(await receiverEffects(rig.receiverPool, row.idempotencyKey)).toBe(1);
    }
    const workersUsed = new Set([...claimedBy.values()].flat());
    expect(workersUsed).toEqual(new Set(["proc-1", "proc-2"]));
    expect(await receiverEffects(rig.receiverPool)).toBe(12);
  });

  it("a worker process is SIGKILLed after the receiver applied and before it recorded anything: the other process recovers it without a duplicate", async () => {
    await rig.reset(CONTRACTS.keyAndLookup);
    const rows = [];
    for (const bookingNo of bookingNos(4)) rows.push((await rig.admitted(bookingNo)).row);

    const startAt = String(Date.now() + 4_000);
    const kill = JSON.stringify([{ at: "worker.after_response", action: { kind: "kill" }, match: { kind: "deliver" } }]);
    const [victim, survivor] = await Promise.all([
      runChild("victim", { START_AT: startAt, LEASE_MS: "3000", TIMEOUT_MS: "1000", FAULTS: kill }),
      runChild("survivor", { START_AT: startAt, LEASE_MS: "3000", TIMEOUT_MS: "1000" }),
    ]);
    expect(victim.signal).toBe("SIGKILL");
    expect(survivor.code, survivor.stderr).toBe(0);

    for (const row of rows) {
      expect((await rig.store.get(row.id))?.status, row.bookingNo).toBe("succeeded");
      expect(await receiverEffects(rig.receiverPool, row.idempotencyKey), row.bookingNo).toBe(1);
    }
    // Find the victim's row from the trail (it never recorded a result). The survivor must have recovered it by
    // reconciliation — not by delivering again — whatever else happened to the other rows under load.
    let victimRows = 0;
    for (const row of rows) {
      const trail = await rig.store.events(row.id);
      if (!trail.some((entry) => entry.event === "claimed_deliver" && entry.workerId === "victim")) continue;
      if (!trail.some((entry) => entry.event === "lease_expired")) continue; // the victim claimed it and finished it (before the kill)
      victimRows += 1;
      expect((await rig.store.get(row.id))?.result).toMatchObject({ source: "reconciliation" });
      expect(await receiverRequests(rig.receiverPool, "deliver", row.idempotencyKey)).toBe(1);
      expect(trail.map((entry) => entry.event)).toEqual(expect.arrayContaining(["lease_expired", "claimed_reconcile", "succeeded"]));
    }
    expect(victimRows).toBe(1);
  });
});
