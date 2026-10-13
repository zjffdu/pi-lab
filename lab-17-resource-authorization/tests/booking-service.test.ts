import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit-log.js";
import { AuthorizationDeniedError, AuthorizationUnavailableError } from "../src/booking-service.js";
import { POLICY_SHA256, POLICY_VERSION } from "../src/policy.js";
import { startRuntime, type TestRuntime } from "./helpers.js";

/**
 * The application boundary with no model involved: the same `BookingService` the tools wrap,
 * called directly. What is enforced here is enforced for a fresh run, a resumed run, and a
 * non-model caller alike.
 */
let rt: TestRuntime;
afterEach(async () => rt?.close());

const app = { channel: "application" } as const;

describe("reads are authorized, not merely tenant-scoped", () => {
  it("returns an owned booking", async () => {
    rt = await startRuntime();
    const booking = await rt.app.bookings.read(rt.as("alice"), "BK1001", app);
    expect(booking).toMatchObject({ bookingNo: "BK1001", vessel: "ALPHA EXPRESS", containerNos: ["MSKU1111111", "MSKU1111112"] });
  });

  it("refuses another employee's booking in the same tenant, with the same text as a missing one", async () => {
    rt = await startRuntime();
    const notYours = await rt.app.bookings.read(rt.as("alice"), "BK2001", app).catch((error: unknown) => error);
    const missing = await rt.app.bookings.read(rt.as("alice"), "BK9999", app).catch((error: unknown) => error);
    expect(notYours).toBeInstanceOf(AuthorizationDeniedError);
    expect(missing).toBeInstanceOf(AuthorizationDeniedError);
    expect((notYours as Error).message).toBe("No booking found for: BK2001");
    expect((missing as Error).message).toBe("No booking found for: BK9999");
    expect((notYours as AuthorizationDeniedError).reason).toBe((missing as AuthorizationDeniedError).reason);
  });

  it("resolves a colliding booking number inside the caller's own tenant", async () => {
    rt = await startRuntime();
    const a = await rt.app.bookings.read(rt.as("alice"), "BK1001", app);
    const b = await rt.app.bookings.read(rt.as("carol", "tenant-b"), "BK1001", app);
    expect(a.vessel).toBe("ALPHA EXPRESS");
    expect(b.vessel).toBe("BRAVO VOYAGER");
  });

  it("lets an approver read any booking in the tenant but nothing in another tenant", async () => {
    rt = await startRuntime();
    expect((await rt.app.bookings.read(rt.as("dave"), "BK2001", app)).ownerSubject).toBe("bob");
    await expect(rt.app.bookings.read(rt.as("dave"), "BK1001", app).then((b) => b.vessel)).resolves.toBe("ALPHA EXPRESS");
    const carol = rt.as("carol", "tenant-b");
    await expect(rt.app.bookings.read(carol, "BK2001", app)).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("uses the current owner: reassignment takes effect on the next call", async () => {
    rt = await startRuntime();
    await rt.app.bookings.read(rt.as("alice"), "BK1001", app);
    await rt.close();
    const rows = (await import("../src/directory.js")).loadDirectoryFixture().bookings.map((b) => (b.bookingNo === "BK1001" && b.tenantId === "tenant-a" ? { ...b, ownerSubject: "bob" } : b));
    rt = await startRuntime({ bookings: rows });
    await expect(rt.app.bookings.read(rt.as("alice"), "BK1001", app)).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(rt.app.bookings.read(rt.as("bob"), "BK1001", app)).resolves.toMatchObject({ bookingNo: "BK1001" });
  });

  it("refuses everything once every role is revoked", async () => {
    rt = await startRuntime();
    rt.app.directory.revoke("tenant-a", "alice", "operator");
    const denied = await rt.app.bookings.read(rt.as("alice"), "BK1001", app).catch((error: unknown) => error);
    expect(denied).toMatchObject({ reason: "no_role_grant" });
  });
});

describe("writes are authorized and produce an effect only when allowed", () => {
  it("changes an owned, editable booking and records the actor at the downstream", async () => {
    rt = await startRuntime();
    const result = await rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "on_hold" }, app);
    expect(result).toEqual({ bookingNo: "BK1001", previousStatus: "booked", newStatus: "on_hold" });
    expect(rt.app.store.statusChanges).toEqual([{ tenantId: "tenant-a", bookingNo: "BK1001", from: "booked", to: "on_hold", actorSubject: "alice" }]);
  });

  it.each([
    ["a viewer", "erin", "tenant-a", "BK5001", "on_hold", "no_role_grant"],
    ["an approver", "dave", "tenant-a", "BK1001", "on_hold", "no_role_grant"],
    ["an operator on a colleague's booking", "alice", "tenant-a", "BK2001", "on_hold", "resource_not_visible"],
    ["an operator on a booking already in transit", "alice", "tenant-a", "BK3001", "on_hold", "state_not_editable"],
    ["an operator requesting a no-op transition", "alice", "tenant-a", "BK1001", "booked", "transition_not_allowed"],
    ["an operator on an unknown booking", "alice", "tenant-a", "BK9999", "on_hold", "resource_not_visible"],
  ])("refuses %s and changes nothing", async (_label, subject, tenant, bookingNo, newStatus, reason) => {
    rt = await startRuntime();
    const denied = await rt.app.bookings.updateStatus(rt.as(subject, tenant), { bookingNo, newStatus }, app).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(AuthorizationDeniedError);
    expect((denied as AuthorizationDeniedError).reason).toBe(reason);
    expect(rt.app.store.statusChanges).toEqual([]);
    expect(rt.app.downstream.log).toEqual([]); // the request never even left the application
  });

  it("a colliding booking number changes only the caller's own tenant's booking", async () => {
    rt = await startRuntime();
    await rt.app.bookings.updateStatus(rt.as("carol", "tenant-b"), { bookingNo: "BK1001", newStatus: "cancelled" }, app);
    expect(rt.app.store.statusChanges).toEqual([{ tenantId: "tenant-b", bookingNo: "BK1001", from: "booked", to: "cancelled", actorSubject: "carol" }]);
    expect(rt.app.store.downstreamFind("tenant-a", "BK1001")?.status).toBe("booked");
  });

  it("applies the current permission: a revocation stops the very next write", async () => {
    rt = await startRuntime();
    await rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "on_hold" }, app);
    rt.app.directory.revoke("tenant-a", "alice", "operator");
    await expect(rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "cancelled" }, app)).rejects.toMatchObject({ reason: "no_role_grant" });
    expect(rt.app.store.statusChanges).toHaveLength(1);
  });

  it("refuses a change if the booking moved between the decision and the write (no double effect)", async () => {
    let interfere: (() => void) | undefined;
    rt = await startRuntime({ afterAuthorization: async () => interfere?.() });
    interfere = () => {
      interfere = undefined;
      rt.app.store.downstreamSetStatus("tenant-a", "BK1001", "cancelled", "someone-else");
    };
    await expect(rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "on_hold" }, app)).rejects.toMatchObject({ code: "conflict" });
    expect(rt.app.store.statusChanges.map((c) => c.actorSubject)).toEqual(["someone-else"]);
  });
});

describe("audit", () => {
  it("records actor, tenant, resource, action, policy version, and decision for allow and deny", async () => {
    rt = await startRuntime();
    await rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "on_hold" }, app);
    await rt.app.bookings.read(rt.as("alice"), "BK2001", app).catch(() => undefined);

    const [allow, deny] = await rt.audit();
    expect(allow).toMatchObject({
      kind: "decision",
      channel: "application",
      actor: "alice",
      tenantId: "tenant-a",
      resource: { bookingNo: "BK1001" },
      action: "booking:update_status",
      requestedStatus: "on_hold",
      decision: "allow",
      matchedRole: "operator",
      roles: ["operator"],
      policyVersion: POLICY_VERSION,
      policySha256: POLICY_SHA256,
    });
    expect(deny).toMatchObject({ actor: "alice", resource: { bookingNo: "BK2001" }, action: "booking:read", decision: "deny", reason: "resource_not_visible", policyVersion: POLICY_VERSION });
  });

  it("does not record booking content, only the identifier the caller named", async () => {
    rt = await startRuntime();
    await rt.app.bookings.read(rt.as("alice"), "BK1001", app);
    const text = (await rt.audit()).map((r) => JSON.stringify(r)).join("\n");
    const markers = rt.app.store.markersFor("tenant-a", "BK1001");
    expect(markers).toEqual(["MSKU1111111", "MSKU1111112", "ALPHA EXPRESS"]); // every container, then the vessel
    for (const marker of markers) expect(text).not.toContain(marker);
  });

  it("fails closed: if the decision cannot be recorded, nothing is done", async () => {
    const failing = new AuditLog(() => {
      throw new Error("audit sink down");
    });
    rt = await startRuntime({ audit: failing });
    const write = await rt.app.bookings.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "on_hold" }, app).catch((error: unknown) => error);
    const read = await rt.app.bookings.read(rt.as("alice"), "BK1001", app).catch((error: unknown) => error);
    expect(write).toBeInstanceOf(AuthorizationUnavailableError);
    expect(read).toBeInstanceOf(AuthorizationUnavailableError);
    expect((write as Error).message).not.toContain("audit sink");
    expect(rt.app.store.statusChanges).toEqual([]);
  });
});
