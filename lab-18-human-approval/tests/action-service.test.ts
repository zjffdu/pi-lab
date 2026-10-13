import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { actionDigest } from "../src/action-digest.js";
import type { ActionView, StepResult } from "../src/action-service.js";
import {
  MINUTE,
  alice,
  bob,
  booking,
  carol,
  count,
  dave,
  erin,
  frank,
  makeService,
  startDb,
  type ServiceKit,
  type TestDb,
} from "./db-helpers.js";

let db: TestDb;
let kit: ServiceKit;

beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
  kit = makeService(db.pool);
});

function must<T>(result: StepResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.value;
}

const proposeHold = async (who = alice(), bookingNo = "BK1001", newStatus = "on_hold"): Promise<ActionView> =>
  must(await kit.service.propose(who, { bookingNo, newStatus, reason: "customs hold" }));

async function approved(): Promise<ActionView> {
  const proposal = await proposeHold();
  return must(await kit.service.approve(bob(), proposal.id, { digest: proposal.digest }));
}

describe("proposal", () => {
  it("is pending, bound to the version and digest, and changes nothing", async () => {
    const action = await proposeHold();
    expect(action.state).toBe("pending");
    expect(action.baseVersion).toBe(1);
    expect(action.digest).toBe(actionDigest({ tenantId: "tenant-a", requester: "alice", bookingNo: "BK1001", newStatus: "on_hold", reason: "customs hold", baseVersion: 1 }));
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
    expect(await count(db.pool, "effects")).toBe(0);
    expect(await count(db.pool, "approvals")).toBe(0);
  });

  it("is refused for a viewer, and creates no row", async () => {
    expect(await kit.service.propose(carol(), { bookingNo: "BK1001", newStatus: "on_hold", reason: "x" })).toEqual({ ok: false, code: "forbidden" });
    expect(await count(db.pool, "actions")).toBe(0);
  });

  it("cannot reach another tenant's booking number", async () => {
    // BK2001 exists only in tenant-a.
    expect(await kit.service.propose(erin(), { bookingNo: "BK2001", newStatus: "on_hold", reason: "x" })).toEqual({ ok: false, code: "not_found" });
  });

  it("rejects a no-op change", async () => {
    expect(await kit.service.propose(alice(), { bookingNo: "BK1001", newStatus: "booked", reason: "x" })).toEqual({ ok: false, code: "no_change" });
  });

  it("targets the caller's own BK1001 when two tenants share the number", async () => {
    const forA = await proposeHold(alice());
    const forB = must(await kit.service.propose(erin(), { bookingNo: "BK1001", newStatus: "on_hold", reason: "customs hold" }));
    expect(forA.digest).not.toBe(forB.digest);
    must(await kit.service.approve(frank(), forB.id, { digest: forB.digest }));
    must(await kit.service.execute(erin(), forB.id));
    expect(await booking(db.pool, "tenant-b", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });
});

describe("decision", () => {
  it("approve records the approver but still applies nothing", async () => {
    const action = await approved();
    expect(action.state).toBe("approved");
    expect(action.approval?.approver).toBe("bob");
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("refuses an approval that presents a different digest", async () => {
    const proposal = await proposeHold();
    expect(await kit.service.approve(bob(), proposal.id, { digest: "0".repeat(64) })).toEqual({ ok: false, code: "digest_mismatch" });
    expect((await kit.service.get(bob(), proposal.id))?.action.state).toBe("pending");
    expect(await count(db.pool, "approvals")).toBe(0);
  });

  it("forbids self-approval even for someone who holds the approver role", async () => {
    const proposal = await proposeHold(dave());
    expect(await kit.service.approve(dave(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "self_approval" });
    expect(await count(db.pool, "approvals")).toBe(0);
  });

  it("forbids approval by a non-approver", async () => {
    const proposal = await proposeHold();
    expect(await kit.service.approve(alice(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "forbidden" });
    expect(await kit.service.approve(carol(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "not_found" });
  });

  it("hides the action from another tenant's approver", async () => {
    const proposal = await proposeHold();
    expect(await kit.service.approve(frank(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "not_found" });
    expect(await kit.service.get(frank(), proposal.id)).toBeUndefined();
  });

  it("reject is terminal", async () => {
    const proposal = await proposeHold();
    expect(must(await kit.service.reject(bob(), proposal.id)).state).toBe("rejected");
    expect(await kit.service.approve(bob(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "invalid_state", state: "rejected" });
    expect(await kit.service.execute(alice(), proposal.id)).toEqual({ ok: false, code: "invalid_state", state: "rejected" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("cannot approve after the decision deadline", async () => {
    const proposal = await proposeHold();
    kit.clock.advance(61 * MINUTE);
    expect(await kit.service.approve(bob(), proposal.id, { digest: proposal.digest })).toEqual({ ok: false, code: "expired", state: "expired" });
    expect((await kit.service.get(bob(), proposal.id))?.action.state).toBe("expired");
  });

  it("expireDue moves overdue pending actions to expired", async () => {
    const proposal = await proposeHold();
    kit.clock.advance(2 * 60 * MINUTE);
    expect(await kit.service.expireDue("tenant-a")).toBe(1);
    expect((await kit.service.get(alice(), proposal.id))?.action.state).toBe("expired");
  });
});

describe("execution handoff", () => {
  it("applies the change once, consumes the approval, and records the trail", async () => {
    const action = await approved();
    const done = must(await kit.service.execute(alice(), action.id));
    expect(done.state).toBe("executed");
    expect(done.effect).toMatchObject({ fromStatus: "booked", toStatus: "on_hold", toVersion: 2, executedBy: "alice" });
    expect(done.approval?.consumedAt).not.toBeNull();
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
    const trail = (await kit.service.get(bob(), action.id))?.events.map((event) => event.event);
    expect(trail).toEqual(["propose", "approve", "execute"]);
  });

  it("refuses to execute an unapproved proposal", async () => {
    const proposal = await proposeHold();
    expect(await kit.service.execute(alice(), proposal.id)).toEqual({ ok: false, code: "invalid_state", state: "pending" });
    expect(await count(db.pool, "effects")).toBe(0);
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
  });

  it("a repeated execution admits nothing new", async () => {
    const action = await approved();
    must(await kit.service.execute(alice(), action.id));
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "invalid_state", state: "executed" });
    expect(await count(db.pool, "effects")).toBe(1);
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
  });

  it("does not let another tenant's principal trigger it", async () => {
    const action = await approved();
    expect(await kit.service.execute(erin(), action.id)).toEqual({ ok: false, code: "not_found" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("does not transfer an old approval to changed arguments", async () => {
    const original = await approved(); // on_hold, approved
    const changed = await proposeHold(alice(), "BK1001", "cancelled"); // new arguments -> new action, new digest
    expect(changed.digest).not.toBe(original.digest);
    expect(await kit.service.execute(alice(), changed.id)).toEqual({ ok: false, code: "invalid_state", state: "pending" });
    expect(await kit.service.approve(bob(), changed.id, { digest: original.digest })).toEqual({ ok: false, code: "digest_mismatch" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("invalidates an approval when the booking version moved after approval", async () => {
    const first = await approved();
    const second = await proposeHold(alice(), "BK1001", "cancelled");
    must(await kit.service.approve(bob(), second.id, { digest: second.digest }));
    must(await kit.service.execute(alice(), second.id));

    expect(await kit.service.execute(alice(), first.id)).toEqual({ ok: false, code: "stale_resource", state: "invalidated" });
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "cancelled", version: 2 });
    expect(await count(db.pool, "effects")).toBe(1);
  });

  it("refuses to approve a proposal whose booking already moved", async () => {
    const first = await proposeHold();
    const second = await proposeHold(alice(), "BK1001", "cancelled");
    must(await kit.service.approve(bob(), second.id, { digest: second.digest }));
    must(await kit.service.execute(alice(), second.id));
    expect(await kit.service.approve(bob(), first.id, { digest: first.digest })).toEqual({ ok: false, code: "stale_resource", state: "invalidated" });
  });

  it("expires an approval that is not used in time", async () => {
    const action = await approved();
    kit.clock.advance(16 * MINUTE);
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "expired", state: "expired" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("refuses when the approver's role was revoked, and recovers if it is restored", async () => {
    const action = await approved();
    kit.directory.revokeRole("tenant-a", "bob", "approver");
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "approver_no_longer_authorized" });
    expect((await kit.service.get(alice(), action.id))?.action.state).toBe("approved");
    expect(await count(db.pool, "effects")).toBe(0);

    kit.directory.grantRole("tenant-a", "bob", "approver");
    expect(must(await kit.service.execute(alice(), action.id)).state).toBe("executed");
  });

  it("refuses when the requester lost the operator role", async () => {
    const action = await approved();
    kit.directory.revokeRole("tenant-a", "alice", "operator");
    // Alice can no longer trigger it herself, and an approver's trigger still fails the requester check.
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "forbidden" });
    expect(await kit.service.execute(bob(), action.id)).toEqual({ ok: false, code: "requester_no_longer_authorized" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("an approver can revoke an unconsumed approval", async () => {
    const action = await approved();
    expect(await kit.service.revoke(alice(), action.id)).toEqual({ ok: false, code: "forbidden" });
    const revoked = must(await kit.service.revoke(dave(), action.id));
    expect(revoked.state).toBe("revoked");
    expect(revoked.approval?.revokedBy).toBe("dave");
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "invalid_state", state: "revoked" });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("cannot revoke an executed action", async () => {
    const action = await approved();
    must(await kit.service.execute(alice(), action.id));
    expect(await kit.service.revoke(bob(), action.id)).toEqual({ ok: false, code: "invalid_state", state: "executed" });
  });
});

describe("tamper resistance", () => {
  it("the database refuses to edit proposal fields", async () => {
    const action = await proposeHold();
    await expect(db.pool.query("UPDATE actions SET new_status = 'cancelled' WHERE id = $1", [action.id])).rejects.toThrow(/immutable/);
  });

  it("the database refuses to move a terminal state", async () => {
    const action = await proposeHold();
    must(await kit.service.reject(bob(), action.id));
    await expect(db.pool.query("UPDATE actions SET state = 'approved' WHERE id = $1", [action.id])).rejects.toThrow(/terminal/);
  });

  it("the audit trail is append-only", async () => {
    await proposeHold();
    await expect(db.pool.query("DELETE FROM action_events")).rejects.toThrow(/append-only/);
  });

  it("execution recomputes the digest, so arguments edited behind the guard are caught", async () => {
    const action = await approved();
    // Simulate an attacker or bug that bypasses the immutability trigger.
    await db.pool.query("ALTER TABLE actions DISABLE TRIGGER actions_guard");
    try {
      await db.pool.query("UPDATE actions SET new_status = 'cancelled' WHERE id = $1", [action.id]);
    } finally {
      await db.pool.query("ALTER TABLE actions ENABLE TRIGGER actions_guard");
    }
    expect(await kit.service.execute(alice(), action.id)).toEqual({ ok: false, code: "digest_mismatch", state: "invalidated" });
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "booked", version: 1 });
    expect(await count(db.pool, "effects")).toBe(0);
  });

  it("effects.action_id is a primary key, the backstop under the logic", async () => {
    const action = await approved();
    must(await kit.service.execute(alice(), action.id));
    await expect(
      db.pool.query(
        `INSERT INTO effects (action_id, tenant_id, booking_no, from_status, to_status, from_version, to_version, executed_by, executed_at)
         VALUES ($1, 'tenant-a', 'BK1001', 'x', 'y', 1, 2, 'mallory', now())`,
        [action.id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("restart and concurrency", () => {
  it("a pending proposal survives a new service instance on the same database", async () => {
    const proposal = await proposeHold();
    const restarted = makeService(db.pool); // fresh objects, nothing in memory
    const seen = await restarted.service.get(bob(), proposal.id);
    expect(seen?.action).toMatchObject({ state: "pending", digest: proposal.digest });
    expect(must(await restarted.service.approve(bob(), proposal.id, { digest: proposal.digest })).state).toBe("approved");
    expect(must(await restarted.service.execute(alice(), proposal.id)).state).toBe("executed");
  });

  it("simultaneous approvals create exactly one approval", async () => {
    const proposal = await proposeHold();
    const results = await Promise.all(
      [bob(), dave(), bob(), dave(), bob(), dave()].map((who) => kit.service.approve(who, proposal.id, { digest: proposal.digest })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((candidate) => !candidate.ok)) expect(result).toMatchObject({ ok: false, code: "invalid_state" });
    expect(await count(db.pool, "approvals")).toBe(1);
  });

  it("an approve racing a reject leaves one decision", async () => {
    const proposal = await proposeHold();
    const results = await Promise.all([
      kit.service.approve(bob(), proposal.id, { digest: proposal.digest }),
      kit.service.reject(dave(), proposal.id),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await count(db.pool, "approvals")).toBe(1);
  });

  it("simultaneous executions admit exactly one business action", async () => {
    const action = await approved();
    const results = await Promise.all([alice(), bob(), dave(), alice(), bob(), dave()].map((who) => kit.service.execute(who, action.id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await count(db.pool, "effects")).toBe(1);
    expect(await booking(db.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
  });

  it("an execute that waits behind an approval sees that approval, not a stale join", async () => {
    const proposal = await proposeHold();
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM actions WHERE id = $1 FOR UPDATE", [proposal.id]);
      const waiting = kit.service.execute(alice(), proposal.id); // blocks on the row lock
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(
        "INSERT INTO approvals (id, action_id, approver, decision, digest, decided_at, expires_at) VALUES (gen_random_uuid(), $1, 'bob', 'approved', $2, $3, $4)",
        [proposal.id, proposal.digest, kit.clock.now(), new Date(kit.clock.now().getTime() + 15 * MINUTE)],
      );
      await holder.query("UPDATE actions SET state = 'approved' WHERE id = $1", [proposal.id]);
      await holder.query("COMMIT");
      expect(must(await waiting).state).toBe("executed");
    } finally {
      holder.release();
    }
  });

  it("two approved actions on one booking: only the first executes, the other is invalidated", async () => {
    const first = await approved();
    const second = await proposeHold(alice(), "BK1001", "cancelled");
    must(await kit.service.approve(bob(), second.id, { digest: second.digest }));
    const results = await Promise.all([kit.service.execute(alice(), first.id), kit.service.execute(alice(), second.id)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await count(db.pool, "effects")).toBe(1);
    expect((await booking(db.pool, "tenant-a", "BK1001")).version).toBe(2);
  });
});

describe("visibility", () => {
  it("shows a requester their own actions and an approver the whole tenant", async () => {
    await proposeHold(alice());
    await proposeHold(dave(), "BK2001", "on_hold");
    expect((await kit.service.list(alice())).map((action) => action.requester)).toEqual(["alice"]);
    expect(await kit.service.list(bob())).toHaveLength(2);
    expect(await kit.service.list(carol())).toHaveLength(0);
    expect(await kit.service.list(frank())).toHaveLength(0);
    expect(await kit.service.list(bob(), { state: "approved" })).toHaveLength(0);
  });
});
