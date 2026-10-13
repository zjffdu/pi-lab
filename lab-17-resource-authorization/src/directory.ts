import { readFileSync } from "node:fs";

import type { Booking } from "./booking-store.js";

export type Role = "viewer" | "operator" | "approver";
export const ROLES: readonly Role[] = ["viewer", "operator", "approver"];

export interface PrincipalGrant {
  tenantId: string;
  subject: string;
  roles: Role[];
}

export interface DirectoryFixture {
  principals: PrincipalGrant[];
  bookings: Booking[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

function isPrincipalGrant(value: unknown): value is PrincipalGrant {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && isString(candidate.subject) && Array.isArray(candidate.roles) && candidate.roles.every(isRole);
}

const BOOKING_STRING_FIELDS = [
  "tenantId",
  "bookingNo",
  "ownerSubject",
  "origin",
  "destination",
  "vessel",
  "plannedDeparture",
  "plannedArrival",
  "status",
] as const;

/** A booking carries at least one container; every container number is a non-empty string. */
function hasContainers(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((containerNo) => isString(containerNo) && containerNo !== "");
}

export function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return hasContainers(candidate.containerNos) && BOOKING_STRING_FIELDS.every((field) => isString(candidate[field]));
}

/** Runtime-validated load of `data/directory.json` — no `as` cast on untrusted fixture data. */
export function loadDirectoryFixture(): DirectoryFixture {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/directory.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("data/directory.json is not an object");
  const { principals, bookings } = parsed as Record<string, unknown>;
  if (!Array.isArray(principals) || !principals.every(isPrincipalGrant)) {
    throw new Error("data/directory.json has an invalid principals array");
  }
  if (!Array.isArray(bookings) || !bookings.every(isBooking)) {
    throw new Error("data/directory.json has an invalid bookings array");
  }
  return { principals, bookings };
}

/**
 * The server-side authority on what each principal may do *today*. Roles are read from here on
 * every decision and every capability resolution — they are never stored in a session, a token,
 * a tool argument, or anything else the client or model can influence. `revoke` / `grant` model
 * an administrator changing permissions between two requests.
 */
export class PermissionDirectory {
  private readonly grants = new Map<string, Set<Role>>();

  public constructor(principals: readonly PrincipalGrant[]) {
    for (const principal of principals) {
      this.grants.set(PermissionDirectory.key(principal.tenantId, principal.subject), new Set(principal.roles));
    }
  }

  private static key(tenantId: string, subject: string): string {
    return JSON.stringify([tenantId, subject]);
  }

  public rolesFor(tenantId: string, subject: string): Role[] {
    return [...(this.grants.get(PermissionDirectory.key(tenantId, subject)) ?? [])];
  }

  public grant(tenantId: string, subject: string, role: Role): void {
    const key = PermissionDirectory.key(tenantId, subject);
    const roles = this.grants.get(key) ?? new Set<Role>();
    roles.add(role);
    this.grants.set(key, roles);
  }

  public revoke(tenantId: string, subject: string, role: Role): void {
    this.grants.get(PermissionDirectory.key(tenantId, subject))?.delete(role);
  }
}
