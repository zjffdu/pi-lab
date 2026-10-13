import { readFileSync } from "node:fs";

import type { Booking } from "./booking-store.js";

export interface Principal {
  tenantId: string;
  subject: string;
}

export interface TenantFixture {
  principals: Principal[];
  bookings: Booking[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && isString(candidate.subject);
}

const BOOKING_STRING_FIELDS = [
  "tenantId",
  "bookingNo",
  "origin",
  "destination",
  "vessel",
  "plannedDeparture",
  "plannedArrival",
  "status",
] as const;

export function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasContainers =
    Array.isArray(candidate.containerNos) &&
    candidate.containerNos.length > 0 &&
    candidate.containerNos.every((containerNo) => isString(containerNo) && containerNo !== "");
  return hasContainers && BOOKING_STRING_FIELDS.every((field) => isString(candidate[field]));
}

/** Runtime-validated load of `data/tenants.json` — no `as` cast on untrusted fixture data. */
export function loadTenantFixture(): TenantFixture {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/tenants.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("data/tenants.json is not an object");
  }
  const { principals, bookings } = parsed as Record<string, unknown>;
  if (!Array.isArray(principals) || !principals.every(isPrincipal)) {
    throw new Error("data/tenants.json has an invalid principals array");
  }
  if (!Array.isArray(bookings) || !bookings.every(isBooking)) {
    throw new Error("data/tenants.json has an invalid bookings array");
  }
  return { principals, bookings };
}

/**
 * Server-side list of known (tenant, subject) pairs. A token that validates cryptographically
 * but names a pair this directory does not know is still rejected: signature validity says who
 * signed the claim, not that the claim names a real principal.
 */
export class PrincipalDirectory {
  private readonly known: Set<string>;

  public constructor(principals: readonly Principal[]) {
    this.known = new Set(principals.map((principal) => JSON.stringify([principal.tenantId, principal.subject])));
  }

  public has(tenantId: string, subject: string): boolean {
    return this.known.has(JSON.stringify([tenantId, subject]));
  }
}
