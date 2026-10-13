import type { Pool } from "pg";

import { ActionService, type ActionServiceOptions, type Clock } from "../src/action-service.js";
import { createPool, createSchema, databaseUrl, dropSchema, migrate, resetData, throwawaySchemaName } from "../src/db.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { Policy } from "../src/policy.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";

export class FakeClock implements Clock {
  private current: number;

  public constructor(start = "2026-09-19T09:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  public now(): Date {
    return new Date(this.current);
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

export const MINUTE = 60 * 1000;

export interface TestDb {
  url: string;
  schema: string;
  pool: Pool;
  /** Truncates all tables and reseeds the fixture bookings. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A migrated database inside a throwaway schema, so test files never see each other's rows. */
export async function startDb(): Promise<TestDb> {
  const url = databaseUrl(process.env.DATABASE_URL ? process.env : (await import("dotenv")).config({ quiet: true }).parsed ?? {});
  const schema = throwawaySchemaName();
  await createSchema(url, schema);
  const pool = createPool(url, schema);
  await migrate(pool);
  const fixture = loadTenantFixture();
  await resetData(pool, fixture.bookings);
  return {
    url,
    schema,
    pool,
    reset: () => resetData(pool, fixture.bookings),
    async close() {
      await pool.end();
      await dropSchema(url, schema);
    },
  };
}

export const ctx = (tenantId: string, subject: string): SecurityContext =>
  mintSecurityContextForTest({ tenantId, subject, requestId: `req-${tenantId}-${subject}` });

export const alice = () => ctx("tenant-a", "alice"); // operator
export const bob = () => ctx("tenant-a", "bob"); // approver
export const carol = () => ctx("tenant-a", "carol"); // viewer
export const dave = () => ctx("tenant-a", "dave"); // operator + approver
export const erin = () => ctx("tenant-b", "erin"); // operator (tenant-b)
export const frank = () => ctx("tenant-b", "frank"); // approver (tenant-b)

export interface ServiceKit {
  service: ActionService;
  directory: PrincipalDirectory;
  clock: FakeClock;
}

export function makeService(pool: Pool, options: Partial<ActionServiceOptions> = {}, directory = new PrincipalDirectory(loadTenantFixture().principals)): ServiceKit {
  const clock = new FakeClock();
  const service = new ActionService({ pool, policy: new Policy(directory), clock, ...options });
  return { service, directory, clock };
}

export async function count(pool: Pool, table: "actions" | "approvals" | "effects" | "action_events"): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
}

export async function booking(pool: Pool, tenantId: string, bookingNo: string): Promise<{ status: string; version: number }> {
  const { rows } = await pool.query<{ status: string; version: number }>("SELECT status, version FROM bookings WHERE tenant_id = $1 AND booking_no = $2", [tenantId, bookingNo]);
  return rows[0] as { status: string; version: number };
}
