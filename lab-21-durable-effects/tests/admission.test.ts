import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Checkpoints, SimulatedCrash } from "../src/checkpoints.js";
import { idempotencyKey } from "../src/idempotency.js";
import { MINUTE, Rig, alice, bob, booking, carol, count, dave, erin, frank, must, receiverEffects, receiverRequests } from "./db-helpers.js";

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

const proposeApprove = async (bookingNo = "BK1001", newStatus = "on_hold") => {
  const proposal = must(await rig.service.propose(alice(), { bookingNo, newStatus, reason: "customs hold" }));
  return must(await rig.service.approve(bob(), proposal.id, { digest: proposal.digest }));
};

describe("admission: approval consumption, execution intent, and the outbox entry in one transaction", () => {
  it("consumes the approval, records the intent and the outbox row, and sends nothing", async () => {
    const approved = await proposeApprove();
    const admitted = must(await rig.service.admit(alice(), approved.id));

    expect(admitted.state).toBe("admitted");
    expect(admitted.approval?.consumedAt).not.toBeNull();
    expect(admitted.delivery).toMatchObject({ status: "pending", idempotencyKey: idempotencyKey({ actionId: approved.id, digest: approved.digest }), deliveryAttempts: 0 });
    expect(await count(rig.pool, "outbox")).toBe(1);
    expect(await receiverRequests(rig.receiverPool, "deliver")).toBe(0);
    expect(await receiverEffects(rig.receiverPool)).toBe(0);
    expect(await booking(rig.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });

    const trail = (await rig.service.get(alice(), approved.id))?.events.map((event) => event.event);
    expect(trail).toEqual(["propose", "approve", "admit"]);
    expect((await rig.store.events(admitted.delivery?.outboxId ?? 0)).map((event) => event.event)).toEqual(["admitted"]);
  });

  it("a crash before commit leaves nothing behind: the approval is still usable, and a retry admits once", async () => {
    await rig.reset(undefined, [], { checkpoints: new Checkpoints([{ at: "admit.before_commit", action: { kind: "crash" } }]) });
    const approved = await proposeApprove();
    await expect(rig.service.admit(alice(), approved.id)).rejects.toBeInstanceOf(SimulatedCrash);

    expect(await count(rig.pool, "outbox")).toBe(0);
    expect(await count(rig.pool, "outbox_events")).toBe(0);
    const after = await rig.service.get(alice(), approved.id);
    expect(after?.action.state).toBe("approved");
    expect(after?.action.approval?.consumedAt).toBeNull();

    // The fault fired once; the same request now succeeds and creates exactly one entry.
    const retried = must(await rig.service.admit(alice(), approved.id));
    expect(retried.state).toBe("admitted");
    expect(await count(rig.pool, "outbox")).toBe(1);
  });

  it("repeated confirmation admits one outbox entry; the later calls are told it is already admitted", async () => {
    const approved = await proposeApprove();
    must(await rig.service.admit(alice(), approved.id));
    expect(await rig.service.admit(alice(), approved.id)).toEqual({ ok: false, code: "already_admitted", state: "admitted" });
    expect(await rig.service.admit(bob(), approved.id)).toEqual({ ok: false, code: "already_admitted", state: "admitted" });
    expect(await count(rig.pool, "outbox")).toBe(1);
  });

  it("simultaneous confirmations admit exactly one outbox entry", async () => {
    const approved = await proposeApprove();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => rig.service.admit(index % 2 === 0 ? alice() : bob(), approved.id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => !result.ok && result.code === "already_admitted")).toBe(true);
    expect(await count(rig.pool, "outbox")).toBe(1);
  });

  it("the database refuses a second outbox row for the same action, whatever the application does", async () => {
    const approved = await proposeApprove();
    const admitted = must(await rig.service.admit(alice(), approved.id));
    await expect(
      rig.pool.query(
        `INSERT INTO outbox (action_id, tenant_id, idempotency_key, booking_no, new_status, base_version, status, next_attempt_at, created_at, updated_at)
         VALUES ($1, 'tenant-a', 'another-key', 'BK1001', 'on_hold', 1, 'pending', now(), now(), now())`,
        [admitted.id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("recomputes the digest at admission: arguments edited behind the trigger's back invalidate the action and admit nothing", async () => {
    const approved = await proposeApprove();
    // Bypass the immutability trigger the way only a privileged, out-of-band write could.
    await rig.pool.query("ALTER TABLE actions DISABLE TRIGGER actions_guard");
    await rig.pool.query("UPDATE actions SET new_status = 'cancelled' WHERE id = $1", [approved.id]);
    await rig.pool.query("ALTER TABLE actions ENABLE TRIGGER actions_guard");

    expect(await rig.service.admit(alice(), approved.id)).toEqual({ ok: false, code: "digest_mismatch", state: "invalidated" });
    expect(await count(rig.pool, "outbox")).toBe(0);
    expect((await rig.service.get(alice(), approved.id))?.action.state).toBe("invalidated");
  });

  it("the outbox request fields are immutable", async () => {
    const approved = await proposeApprove();
    must(await rig.service.admit(alice(), approved.id));
    await expect(rig.pool.query("UPDATE outbox SET new_status = 'cancelled'")).rejects.toThrow(/immutable/);
    await expect(rig.pool.query("UPDATE outbox SET idempotency_key = 'other'")).rejects.toThrow(/immutable/);
  });

  it("refuses an unapproved, rejected, or foreign action, and creates no outbox row", async () => {
    const proposal = must(await rig.service.propose(alice(), { bookingNo: "BK1001", newStatus: "on_hold", reason: "x" }));
    expect(await rig.service.admit(alice(), proposal.id)).toEqual({ ok: false, code: "invalid_state", state: "pending" });
    const approved = must(await rig.service.approve(bob(), proposal.id, { digest: proposal.digest }));
    expect(await rig.service.admit(carol(), approved.id)).toEqual({ ok: false, code: "not_found" });
    expect(await rig.service.admit(erin(), approved.id)).toEqual({ ok: false, code: "not_found" });
    expect(await rig.service.admit(frank(), approved.id)).toEqual({ ok: false, code: "not_found" });
    expect(await count(rig.pool, "outbox")).toBe(0);
  });

  it("an approval that expired before admission cannot be admitted", async () => {
    const approved = await proposeApprove();
    rig.clock.advance(16 * MINUTE);
    expect(await rig.service.admit(alice(), approved.id)).toEqual({ ok: false, code: "expired", state: "expired" });
    expect(await count(rig.pool, "outbox")).toBe(0);
  });

  it("a revoked approval cannot be admitted", async () => {
    const approved = await proposeApprove();
    must(await rig.service.revoke(bob(), approved.id));
    expect(await rig.service.admit(alice(), approved.id)).toEqual({ ok: false, code: "invalid_state", state: "revoked" });
    expect(await count(rig.pool, "outbox")).toBe(0);
  });

  it("a role removed before admission refuses the step and leaves the approval standing", async () => {
    const approved = await proposeApprove();
    rig.directory.revokeRole("tenant-a", "bob", "approver");
    expect(await rig.service.admit(alice(), approved.id)).toEqual({ ok: false, code: "approver_no_longer_authorized" });
    expect(await count(rig.pool, "outbox")).toBe(0);
    rig.directory.grantRole("tenant-a", "bob", "approver");
    expect(must(await rig.service.admit(alice(), approved.id)).state).toBe("admitted");
  });

  it("self-approval is still refused (Lab 18's separation of duties carries over)", async () => {
    const proposal = must(await rig.service.propose(dave(), { bookingNo: "BK1001", newStatus: "on_hold", reason: "x" }));
    expect(await rig.service.approve(dave(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "self_approval" });
  });

  it("the idempotency key belongs to the action: distinct actions never share one, the same action always has one", async () => {
    const a = must(await rig.service.admit(alice(), (await proposeApprove("BK1001", "on_hold")).id));
    const b = must(await rig.service.admit(alice(), (await proposeApprove("BK2001", "cancelled")).id));
    expect(a.delivery?.idempotencyKey).not.toBe(b.delivery?.idempotencyKey);
    expect((await rig.store.getByAction(a.id))?.idempotencyKey).toBe(a.delivery?.idempotencyKey);
  });
});
