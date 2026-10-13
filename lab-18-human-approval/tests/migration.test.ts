import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, createSchema, dropSchema, throwawaySchemaName } from "../src/db.js";
import { startDb, type TestDb } from "./db-helpers.js";

const sql = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

describe("migration 003: container_no -> container_nos", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb(); // only to get the connection URL
  });
  afterAll(async () => {
    await db.close();
  });

  it("keeps an existing booking's one container as a one-element array", async () => {
    // A database that already ran migrations 001 and 002 and holds a booking with the old column.
    const schema = throwawaySchemaName();
    await createSchema(db.url, schema);
    const pool = createPool(db.url, schema);
    try {
      await pool.query(sql("001_init.sql"));
      await pool.query(sql("002_status_domain.sql"));
      await pool.query(
        "INSERT INTO bookings (tenant_id, booking_no, container_no, origin, destination, vessel, planned_departure, planned_arrival, status) VALUES ('t', 'BK9', 'MSKU0000001', 'a', 'b', 'v', 'd', 'd', 'booked')",
      );

      await pool.query(sql("003_container_nos.sql"));

      const { rows } = await pool.query<{ container_nos: string[] }>("SELECT container_nos FROM bookings WHERE booking_no = 'BK9'");
      expect(rows[0]?.container_nos).toEqual(["MSKU0000001"]);
      await expect(pool.query("SELECT container_no FROM bookings")).rejects.toThrow(/container_no/);
    } finally {
      await pool.end();
      await dropSchema(db.url, schema);
    }
  });
});
