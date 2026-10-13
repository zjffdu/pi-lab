import { createHash } from "node:crypto";

import type { ResourceView } from "./booking-store.js";
import type { Role } from "./directory.js";

/**
 * Bump on any change to the tables below. Every audit record carries it, so a decision can be
 * tied to the rules that produced it.
 */
export const POLICY_VERSION = "2026-09-19.1";

export type Action = "booking:read" | "booking:update_status" | "booking:approve";

/** `owner`: only resources whose `ownerSubject` is the caller. `tenant`: any resource in the caller's tenant. */
export type Scope = "owner" | "tenant";

/**
 * The whole role model. `booking:approve` is decision-only in this lab — no tool or endpoint
 * exercises it until Lab 18 adds the approval flow — but it is in the matrix so the three roles
 * are complete and the approver/operator separation is visible.
 */
export const ROLE_GRANTS: Readonly<Record<Role, Readonly<Partial<Record<Action, Scope>>>>> = {
  viewer: { "booking:read": "owner" },
  operator: { "booking:read": "owner", "booking:update_status": "owner" },
  approver: { "booking:read": "tenant", "booking:approve": "tenant" },
};

/** Current status -> statuses a change may move it to. A status absent here is not editable. */
export const STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  booked: ["on_hold", "cancelled"],
  on_hold: ["booked", "cancelled"],
};

export const EDITABLE_TARGET_STATUSES = ["booked", "on_hold", "cancelled"] as const;

export const POLICY_SHA256 = createHash("sha256").update(JSON.stringify([ROLE_GRANTS, STATUS_TRANSITIONS])).digest("hex");

export type DenyReason =
  /** No role the principal currently holds grants this action at all. */
  | "no_role_grant"
  /** Resource missing, in another tenant, or outside the role's scope — deliberately one reason. */
  | "resource_not_visible"
  /** Resource is visible but its current status does not allow the change. */
  | "state_not_editable"
  | "transition_not_allowed";

export type Decision =
  | { allowed: true; matchedRole: Role; policyVersion: string }
  | { allowed: false; reason: DenyReason; policyVersion: string };

export interface PolicyInput {
  principal: { tenantId: string; subject: string };
  /** The principal's roles *at decision time*, from the server-side directory. */
  roles: readonly Role[];
  action: Action;
  /** Undefined when the caller named a resource that does not exist in the principal's tenant. */
  resource: ResourceView | undefined;
  requestedStatus?: string;
}

function deny(reason: DenyReason): Decision {
  return { allowed: false, reason, policyVersion: POLICY_VERSION };
}

/** Roles that grant `action`, with the scope each grants it at. */
function grantsFor(roles: readonly Role[], action: Action): Array<{ role: Role; scope: Scope }> {
  return roles.flatMap((role) => {
    const scope = ROLE_GRANTS[role][action];
    return scope === undefined ? [] : [{ role, scope }];
  });
}

/**
 * Pure and deterministic: tenant, role, ownership, action, and current resource state in; a
 * decision out. Check order is part of the contract — role first (so a caller without the
 * capability learns nothing about any resource), then visibility (one reason for "missing",
 * "other tenant", and "not yours"), then state.
 */
export function decide(input: PolicyInput): Decision {
  const grants = grantsFor(input.roles, input.action);
  if (grants.length === 0) return deny("no_role_grant");

  const resource = input.resource;
  const visibleUnder = (scope: Scope) =>
    resource !== undefined &&
    resource.tenantId === input.principal.tenantId &&
    (scope === "tenant" || resource.ownerSubject === input.principal.subject);
  const matched = grants.find((grant) => visibleUnder(grant.scope));
  if (!matched) return deny("resource_not_visible");

  if (input.action === "booking:update_status") {
    const allowedTargets = STATUS_TRANSITIONS[resource?.status ?? ""];
    if (allowedTargets === undefined) return deny("state_not_editable");
    if (input.requestedStatus === undefined || !allowedTargets.includes(input.requestedStatus)) return deny("transition_not_allowed");
  }

  return { allowed: true, matchedRole: matched.role, policyVersion: POLICY_VERSION };
}
