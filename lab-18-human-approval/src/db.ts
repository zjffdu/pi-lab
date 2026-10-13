import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import pg from "pg";

import type { Booking } from "./directory.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export class DatabaseNotConfiguredError extends Error {
  public constructor() {
    super("DATABASE_URL is not set. Run `npm run db:up` (starts the lab's local Postgres and writes .env), then retry.");
    this.name = "DatabaseNotConfiguredError";
  }
}

export function databaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const url = environment.DATABASE_URL?.trim();
  if (!url) throw new DatabaseNotConfiguredError();
  return url;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * A pool whose connections all resolve unqualified names inside `schema`. Tests and the demo pass
 * a throwaway schema so they never touch each other's rows; `npm run dev` uses the default one.
 */
export function createPool(url: string, schema?: string): pg.Pool {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) throw new Error(`Unsafe schema name: ${schema}`);
  return new pg.Pool({ connectionString: url, max: 10, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

export function throwawaySchemaName(): string {
  return `lab18_${randomBytes(6).toString("hex")}`;
}

export async function createSchema(url: string, schema: string): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Unsafe schema name: ${schema}`);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
}

export async function dropSchema(url: string, schema: string): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Unsafe schema name: ${schema}`);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** Highest applied migration file name, recorded in the evidence manifest as the schema version. */
export const SCHEMA_VERSION = migrationFiles().at(-1) ?? "none";

/** Applies each not-yet-applied `migrations/*.sql` in order, one transaction per file. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const ran: string[] = [];
  for (const file of migrationFiles()) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(new URL(file, MIGRATIONS_DIR), "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return ran;
}

export async function seedBookings(pool: pg.Pool, bookings: readonly Booking[]): Promise<void> {
  for (const booking of bookings) {
    await pool.query(
      `INSERT INTO bookings (tenant_id, booking_no, container_nos, origin, destination, vessel, planned_departure, planned_arrival, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, booking_no) DO NOTHING`,
      [booking.tenantId, booking.bookingNo, booking.containerNos, booking.origin, booking.destination, booking.vessel, booking.plannedDeparture, booking.plannedArrival, booking.status],
    );
  }
}

/** Empties every table and reseeds the fixture bookings. Test/demo use only. */
export async function resetData(pool: pg.Pool, bookings: readonly Booking[]): Promise<void> {
  await pool.query("TRUNCATE effects, approvals, action_events, actions, bookings");
  await seedBookings(pool, bookings);
}
