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
  /** One booking can carry several containers; a status belongs to the booking as a whole. */
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  status: string;
}

/** Per-tenant outbound rules: the only addresses an outbound tool may ever send to. */
export interface EgressConfig {
  tenantId: string;
  allowedRecipients: string[];
}

export interface TenantFixture {
  principals: Principal[];
  bookings: Booking[];
  egress: EgressConfig[];
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value);

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && isString(candidate.subject) && Array.isArray(candidate.roles) && candidate.roles.every(isRole);
}

function isEgress(value: unknown): value is EgressConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && Array.isArray(candidate.allowedRecipients) && candidate.allowedRecipients.every(isString);
}

const BOOKING_FIELDS = ["tenantId", "bookingNo", "origin", "destination", "vessel", "plannedDeparture", "plannedArrival", "status"] as const;

export function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    BOOKING_FIELDS.every((field) => isString(candidate[field])) &&
    Array.isArray(candidate.containerNos) &&
    candidate.containerNos.length > 0 &&
    candidate.containerNos.every((containerNo) => isString(containerNo) && containerNo !== "")
  );
}

/** Runtime-validated load of `data/tenants.json` — no `as` cast on fixture data. */
export function loadTenantFixture(): TenantFixture {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/tenants.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("data/tenants.json is not an object");
  const { principals, bookings, egress } = parsed as Record<string, unknown>;
  if (!Array.isArray(principals) || !principals.every(isPrincipal)) throw new Error("data/tenants.json has an invalid principals array");
  if (!Array.isArray(bookings) || !bookings.every(isBooking)) throw new Error("data/tenants.json has an invalid bookings array");
  if (!Array.isArray(egress) || !egress.every(isEgress)) throw new Error("data/tenants.json has an invalid egress array");
  return { principals, bookings, egress };
}

const key = (tenantId: string, subject: string): string => JSON.stringify([tenantId, subject]);

/**
 * Server-side principals and their roles, read at decision time. Roles are not in the token and
 * cannot come from the prompt, a document, or a tool argument. `revokeRole` lets a test or demo
 * change a role after content has already entered a conversation.
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

  public rolesOf(tenantId: string, subject: string): Role[] {
    return [...(this.roles.get(key(tenantId, subject)) ?? [])];
  }

  public revokeRole(tenantId: string, subject: string, role: Role): void {
    this.roles.get(key(tenantId, subject))?.delete(role);
  }

  public grantRole(tenantId: string, subject: string, role: Role): void {
    this.roles.get(key(tenantId, subject))?.add(role);
  }
}
