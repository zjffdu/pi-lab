import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import pg from "pg";

import type { Booking } from "./directory.js";

// Copied from Lab 18's db.ts (see SOURCES.sha256) and changed to run two independent migration sets:
// `app` (the application's schema) and `receiver` (the downstream system's schema). Each lives in its
// own Postgres schema and is reached through its own pool, so the two never share a transaction.
export type SchemaKind = "app" | "receiver";

const MIGRATIONS_ROOT = new URL("../migrations/", import.meta.url);
const dirOf = (kind: SchemaKind): URL => new URL(`${kind}/`, MIGRATIONS_ROOT);

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
 * throwaway schemas so they never touch each other's rows.
 */
export function createPool(url: string, schema?: string, max = 10): pg.Pool {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) throw new Error(`Unsafe schema name: ${schema}`);
  return new pg.Pool({ connectionString: url, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

export function throwawaySchemaName(kind: SchemaKind = "app"): string {
  return `lab21_${kind}_${randomBytes(6).toString("hex")}`;
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

export function migrationFiles(kind: SchemaKind): string[] {
  return readdirSync(dirOf(kind))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** Highest applied migration file name per schema kind, recorded in the evidence manifest. */
export const SCHEMA_VERSION = {
  app: migrationFiles("app").at(-1) ?? "none",
  receiver: migrationFiles("receiver").at(-1) ?? "none",
} as const;

/** Applies each not-yet-applied `migrations/<kind>/*.sql` in order, one transaction per file. */
export async function migrate(pool: pg.Pool, kind: SchemaKind): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const ran: string[] = [];
  for (const file of migrationFiles(kind)) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(new URL(file, dirOf(kind)), "utf8"));
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
      `INSERT INTO bookings (tenant_id, booking_no, container_no, origin, destination, vessel, planned_departure, planned_arrival, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, booking_no) DO NOTHING`,
      [booking.tenantId, booking.bookingNo, booking.containerNo, booking.origin, booking.destination, booking.vessel, booking.plannedDeparture, booking.plannedArrival, booking.status],
    );
  }
}

/** Empties every application table and reseeds the fixture bookings. Test/demo use only. */
export async function resetData(pool: pg.Pool, bookings: readonly Booking[]): Promise<void> {
  await pool.query("TRUNCATE outbox_events, outbox, approvals, action_events, actions, bookings CASCADE");
  await seedBookings(pool, bookings);
}

/** Empties every receiver table and reseeds its own copy of the fixture bookings (version 1). */
export async function resetReceiver(pool: pg.Pool, bookings: readonly Booking[]): Promise<void> {
  await pool.query("TRUNCATE receiver_requests, receiver_fences, receiver_keys, receiver_effects, receiver_bookings");
  for (const booking of bookings) {
    await pool.query("INSERT INTO receiver_bookings (tenant_id, booking_no, status) VALUES ($1, $2, $3)", [booking.tenantId, booking.bookingNo, booking.status]);
  }
}
