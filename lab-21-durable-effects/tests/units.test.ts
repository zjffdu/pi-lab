import { describe, expect, it } from "vitest";

import { ACTION_STATES, TERMINAL_STATES, fromStates, nextState } from "../src/action-state.js";
import { CHECKPOINTS, Checkpoints, SimulatedCrash, faultsFromEnvironment } from "../src/checkpoints.js";
import { idempotencyKey, requestHash } from "../src/idempotency.js";
import { OUTBOX_STATUSES } from "../src/outbox.js";
import { parseDeliverRequest, parseDeliverResponse, parseLookupResponse } from "../src/receiver/contract.js";

describe("idempotency key", () => {
  const base = { actionId: "0b5f0a52-7f7f-4b7f-9a3a-1c1c1c1c1c1c", digest: "a".repeat(64) };

  it("is a pure function of the action's identity", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
    expect(idempotencyKey(base)).toMatch(/^wb1-[0-9a-f]{40}$/);
  });

  it("differs when the action ID or the approved digest differs", () => {
    expect(idempotencyKey({ ...base, actionId: "1b5f0a52-7f7f-4b7f-9a3a-1c1c1c1c1c1c" })).not.toBe(idempotencyKey(base));
    expect(idempotencyKey({ ...base, digest: "b".repeat(64) })).not.toBe(idempotencyKey(base));
  });

  it("request hash tells apart requests that share a key", () => {
    const request = { tenantId: "tenant-a", bookingNo: "BK1001", newStatus: "on_hold", expectedVersion: 1 };
    expect(requestHash(request)).toBe(requestHash({ ...request }));
    expect(requestHash({ ...request, newStatus: "cancelled" })).not.toBe(requestHash(request));
    expect(requestHash({ ...request, expectedVersion: 2 })).not.toBe(requestHash(request));
  });
});

describe("approval lifecycle table (Lab 18's, with admit in place of execute)", () => {
  it("admitted is terminal and only reachable from approved", () => {
    expect(TERMINAL_STATES).toContain("admitted");
    expect(fromStates("admit")).toEqual(["approved"]);
    expect(nextState("approved", "admit")).toBe("admitted");
    for (const state of ACTION_STATES.filter((candidate) => candidate !== "approved")) expect(nextState(state, "admit")).toBeUndefined();
  });
});

describe("outbox status set", () => {
  it("names exactly the states the roadmap asks to distinguish, plus the manual-review escape hatch", () => {
    expect([...OUTBOX_STATUSES].sort()).toEqual(["failed", "in_flight", "manual_review", "pending", "succeeded", "unknown"]);
  });
});

describe("checkpoints", () => {
  it("does nothing without a plan, counts hits, and fires a fault the requested number of times", async () => {
    const cps = new Checkpoints([{ at: "worker.after_claim", action: { kind: "crash" }, times: 2 }]);
    await expect(cps.hit("worker.after_claim")).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(cps.hit("worker.after_claim")).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(cps.hit("worker.after_claim")).resolves.toBeUndefined();
    expect(cps.hitCount("worker.after_claim")).toBe(3);
    expect(cps.hitCount("worker.before_send")).toBe(0);
  });

  it("applies a fault only where its filter matches", async () => {
    const cps = new Checkpoints([{ at: "worker.before_send", action: { kind: "crash" }, match: { worker: "A" } }]);
    await expect(cps.hit("worker.before_send", { worker: "B" })).resolves.toBeUndefined();
    await expect(cps.hit("worker.before_send", { worker: "A" })).rejects.toBeInstanceOf(SimulatedCrash);
  });

  it("hands receiver-side faults back to the caller", async () => {
    const cps = new Checkpoints([
      { at: "receiver.after_apply", action: { kind: "drop" } },
      { at: "receiver.before_apply", action: { kind: "http", status: 503 } },
    ]);
    expect(await cps.hit("receiver.after_apply")).toEqual({ kind: "drop" });
    expect(await cps.hit("receiver.before_apply")).toEqual({ kind: "http", status: 503 });
  });

  it("parses FAULTS from the environment and rejects unknown checkpoint names", () => {
    expect(faultsFromEnvironment(undefined)).toEqual([]);
    expect(faultsFromEnvironment(JSON.stringify([{ at: "worker.after_response", action: { kind: "kill" } }]))).toHaveLength(1);
    expect(() => faultsFromEnvironment(JSON.stringify([{ at: "worker.nowhere", action: { kind: "kill" } }]))).toThrow(/known checkpoint/);
    expect([...CHECKPOINTS]).toEqual([
      "admit.before_commit",
      "worker.after_claim",
      "worker.before_send",
      "worker.after_response",
      "worker.before_result_commit",
      "worker.after_result_commit",
      "receiver.before_apply",
      "receiver.after_apply",
    ]);
  });
});

describe("wire contract validators", () => {
  it("accept well-formed messages and reject anything else without casting", () => {
    expect(parseDeliverRequest({ tenantId: "t", bookingNo: "B", newStatus: "s", expectedVersion: 1 })).toBeDefined();
    expect(parseDeliverRequest({ tenantId: "t", bookingNo: "B", newStatus: "s", expectedVersion: "1" })).toBeUndefined();
    expect(parseDeliverResponse({ result: "applied", replayed: false, effectId: 1, bookingNo: "B", newStatus: "s", toVersion: 2 })).toBeDefined();
    expect(parseDeliverResponse({ result: "applied" })).toBeUndefined();
    expect(parseDeliverResponse({ result: "rejected", code: "version_conflict" })).toEqual({ result: "rejected", code: "version_conflict" });
    expect(parseLookupResponse({ state: "not_found" })).toEqual({ state: "not_found" });
    expect(parseLookupResponse({ state: "applied", bookingNo: "B" })).toBeUndefined();
    expect(parseLookupResponse("nope")).toBeUndefined();
  });
});

describe("worker configuration", () => {
  it("refuses a lease that does not outlive one receiver request", async () => {
    const { DeliveryWorker } = await import("../src/delivery-worker.js");
    const { ReceiverClient } = await import("../src/receiver-client.js");
    const options = {
      workerId: "w",
      pool: {} as never,
      clock: { now: () => new Date() },
      client: new ReceiverClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 5_000 }),
      contract: { idempotency: "key", lookup: true, fencing: false } as const,
    };
    expect(() => new DeliveryWorker({ ...options, leaseMs: 5_000 })).toThrow(/outlive/);
    expect(() => new DeliveryWorker({ ...options, leaseMs: 5_001 })).not.toThrow();
  });
});
