import { describe, expect, it } from "vitest";

import type { ResourceView } from "../src/booking-store.js";
import type { Role } from "../src/directory.js";
import { decide, POLICY_VERSION, STATUS_TRANSITIONS, type Action, type DenyReason } from "../src/policy.js";

const alice = { tenantId: "tenant-a", subject: "alice" };

const resources = {
  own: { tenantId: "tenant-a", bookingNo: "BK1", ownerSubject: "alice", status: "booked" },
  someoneElses: { tenantId: "tenant-a", bookingNo: "BK2", ownerSubject: "bob", status: "booked" },
  ownInTransit: { tenantId: "tenant-a", bookingNo: "BK3", ownerSubject: "alice", status: "in_transit" },
  // Another tenant's booking whose owner string happens to equal ours: tenant scope must still exclude it.
  otherTenantSameOwnerName: { tenantId: "tenant-b", bookingNo: "BK1", ownerSubject: "alice", status: "booked" },
  missing: undefined,
} satisfies Record<string, ResourceView | undefined>;
type ResourceKey = keyof typeof resources;

type Expected = "allow" | DenyReason;

function outcome(roles: Role[], action: Action, resource: ResourceKey, requestedStatus?: string): Expected {
  const decision = decide({ principal: alice, roles, action, resource: resources[resource], requestedStatus });
  expect(decision.policyVersion).toBe(POLICY_VERSION);
  return decision.allowed ? "allow" : decision.reason;
}

describe("policy matrix — booking:read", () => {
  const cases: Array<[Role, ResourceKey, Expected]> = [
    ["viewer", "own", "allow"],
    ["viewer", "someoneElses", "resource_not_visible"],
    ["viewer", "ownInTransit", "allow"],
    ["viewer", "otherTenantSameOwnerName", "resource_not_visible"],
    ["viewer", "missing", "resource_not_visible"],
    ["operator", "own", "allow"],
    ["operator", "someoneElses", "resource_not_visible"],
    ["operator", "otherTenantSameOwnerName", "resource_not_visible"],
    ["operator", "missing", "resource_not_visible"],
    ["approver", "own", "allow"],
    ["approver", "someoneElses", "allow"],
    ["approver", "ownInTransit", "allow"],
    ["approver", "otherTenantSameOwnerName", "resource_not_visible"],
    ["approver", "missing", "resource_not_visible"],
  ];
  it.each(cases)("%s reading %s -> %s", (role, resource, expected) => {
    expect(outcome([role], "booking:read", resource)).toBe(expected);
  });
});

describe("policy matrix — booking:update_status", () => {
  it.each<[Role, Expected]>([
    ["viewer", "no_role_grant"],
    ["approver", "no_role_grant"],
  ])("%s can never update, whatever the resource (%s)", (role, expected) => {
    for (const resource of Object.keys(resources) as ResourceKey[]) {
      expect(outcome([role], "booking:update_status", resource, "on_hold")).toBe(expected);
    }
  });

  const operatorCases: Array<[ResourceKey, string, Expected]> = [
    ["own", "on_hold", "allow"],
    ["own", "cancelled", "allow"],
    ["own", "booked", "transition_not_allowed"],
    ["own", "in_transit", "transition_not_allowed"],
    ["someoneElses", "on_hold", "resource_not_visible"],
    ["ownInTransit", "on_hold", "state_not_editable"],
    ["otherTenantSameOwnerName", "on_hold", "resource_not_visible"],
    ["missing", "on_hold", "resource_not_visible"],
  ];
  it.each(operatorCases)("operator updating %s to %s -> %s", (resource, status, expected) => {
    expect(outcome(["operator"], "booking:update_status", resource, status)).toBe(expected);
  });

  it("follows the transition table for every editable status", () => {
    for (const [from, targets] of Object.entries(STATUS_TRANSITIONS)) {
      const resource: ResourceView = { ...resources.own, status: from };
      for (const to of ["booked", "on_hold", "cancelled"]) {
        const decision = decide({ principal: alice, roles: ["operator"], action: "booking:update_status", resource, requestedStatus: to });
        expect(decision.allowed).toBe(targets.includes(to));
      }
    }
  });

  it("treats a terminal status as not editable", () => {
    const resource: ResourceView = { ...resources.own, status: "cancelled" };
    const decision = decide({ principal: alice, roles: ["operator"], action: "booking:update_status", resource, requestedStatus: "booked" });
    expect(decision).toMatchObject({ allowed: false, reason: "state_not_editable" });
  });
});

describe("policy matrix — booking:approve (decision only; no tool or endpoint until Lab 18)", () => {
  it.each<[Role, ResourceKey, Expected]>([
    ["viewer", "own", "no_role_grant"],
    ["operator", "own", "no_role_grant"],
    ["approver", "own", "allow"],
    ["approver", "someoneElses", "allow"],
    ["approver", "otherTenantSameOwnerName", "resource_not_visible"],
    ["approver", "missing", "resource_not_visible"],
  ])("%s approving %s -> %s", (role, resource, expected) => {
    expect(outcome([role], "booking:approve", resource)).toBe(expected);
  });
});

describe("policy — role combinations and determinism", () => {
  it("allows when any held role allows, and reports which one", () => {
    const decision = decide({ principal: alice, roles: ["viewer", "operator"], action: "booking:update_status", resource: resources.own, requestedStatus: "on_hold" });
    expect(decision).toMatchObject({ allowed: true, matchedRole: "operator" });
  });

  it("denies everything for a principal holding no role", () => {
    for (const action of ["booking:read", "booking:update_status", "booking:approve"] as const) {
      expect(outcome([], action, "own", "on_hold")).toBe("no_role_grant");
    }
  });

  it("checks the role before looking at the resource, so a role-less caller learns nothing about it", () => {
    expect(outcome([], "booking:read", "missing")).toBe("no_role_grant");
    expect(outcome([], "booking:read", "own")).toBe("no_role_grant");
  });

  it("gives the same answer for the same inputs", () => {
    const input = { principal: alice, roles: ["operator"] as Role[], action: "booking:update_status" as const, resource: resources.own, requestedStatus: "cancelled" };
    expect(decide(input)).toEqual(decide(input));
  });
});
