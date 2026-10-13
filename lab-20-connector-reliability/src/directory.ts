import { readFileSync } from "node:fs";

export const ROLES = ["viewer", "operator", "approver"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  tenantId: string;
  subject: string;
  roles: Role[];
}

export interface TenantFixture {
  principals: Principal[];
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value);

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.tenantId) && isString(candidate.subject) && Array.isArray(candidate.roles) && candidate.roles.every(isRole);
}

/** Runtime-validated load of `data/tenants.json` — no `as` cast on fixture data. */
export function loadTenantFixture(): TenantFixture {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/tenants.json", import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("data/tenants.json is not an object");
  const { principals } = parsed as Record<string, unknown>;
  if (!Array.isArray(principals) || !principals.every(isPrincipal)) throw new Error("data/tenants.json has an invalid principals array");
  return { principals };
}

const key = (tenantId: string, subject: string): string => JSON.stringify([tenantId, subject]);

/**
 * Server-side principals and their roles, read at decision time. Roles are not in the token and
 * cannot come from the prompt or a tool argument. Copied from Lab 19 without the egress and booking
 * parts: this lab's booking data lives behind the connector, not in the application.
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
}
