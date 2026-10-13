import { readFileSync } from "node:fs";

export const ROLES = ["viewer", "operator", "approver"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  tenantId: string;
  subject: string;
  roles: Role[];
}

export interface Booking {
  tenantId: string;
  bookingNo: string;
  /** A booking can carry several containers; at least one. Its status belongs to the booking, not to a container. */
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  status: string;
}

export interface TenantFixture {
  principals: Principal[];
  bookings: Booking[];
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value);

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && isString(candidate.subject) && Array.isArray(candidate.roles) && candidate.roles.every(isRole);
}

const BOOKING_FIELDS = ["tenantId", "bookingNo", "origin", "destination", "vessel", "plannedDeparture", "plannedArrival", "status"] as const;

export function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasContainers =
    Array.isArray(candidate.containerNos) && candidate.containerNos.length > 0 && candidate.containerNos.every((containerNo) => isString(containerNo) && containerNo !== "");
  return hasContainers && BOOKING_FIELDS.every((field) => isString(candidate[field]));
}

/** Runtime-validated load of `data/tenants.json` — no `as` cast on fixture data. */
export function loadTenantFixture(): TenantFixture {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/tenants.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("data/tenants.json is not an object");
  const { principals, bookings } = parsed as Record<string, unknown>;
  if (!Array.isArray(principals) || !principals.every(isPrincipal)) throw new Error("data/tenants.json has an invalid principals array");
  if (!Array.isArray(bookings) || !bookings.every(isBooking)) throw new Error("data/tenants.json has an invalid bookings array");
  return { principals, bookings };
}

const key = (tenantId: string, subject: string): string => JSON.stringify([tenantId, subject]);

/**
 * Server-side principals and their roles. Roles are looked up here at decision time — they are
 * not in the token and cannot come from the prompt or a tool argument. `revokeRole` exists so a
 * test (and the demo) can change a role between approval and execution.
 */
export class PrincipalDirectory {
  private readonly roles = new Map<string, Set<Role>>();

  public constructor(principals: readonly Principal[]) {
    for (const principal of principals) this.roles.set(key(principal.tenantId, principal.subject), new Set(principal.roles));
  }

  public has(tenantId: string, subject: string): boolean {
    return this.roles.has(key(tenantId, subject));
  }

  public hasRole(tenantId: string, subject: string, role: Role): boolean {
    return this.roles.get(key(tenantId, subject))?.has(role) ?? false;
  }

  public revokeRole(tenantId: string, subject: string, role: Role): void {
    this.roles.get(key(tenantId, subject))?.delete(role);
  }

  public grantRole(tenantId: string, subject: string, role: Role): void {
    this.roles.get(key(tenantId, subject))?.add(role);
  }
}
