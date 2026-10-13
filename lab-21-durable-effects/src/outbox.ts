import type { Pool, PoolClient } from "pg";

import type { Clock } from "./action-service.js";

/**
 * The delivery lifecycle of one admitted action, as data. The approval lifecycle (`action-state.ts`)
 * ends at `admitted`; everything after that is this table's business.
 *
 *   pending --claim(deliver)--> in_flight --applied-------------------------> succeeded
 *      ^                          |  |  \--rejected / retries exhausted------> failed
 *      |                          |  \--not sent, retry later (backoff)-----> pending
 *      |                          \--ambiguous | lease expired---------------> unknown
 *      |                                                                         |
 *      +----- reconcile: receiver has no record, safe to resend (idempotent) ----+
 *             reconcile: receiver confirms  ---> succeeded / failed
 *             reconcile: cannot decide safely --> manual_review --(person)--> succeeded | failed | pending
 */
export const OUTBOX_STATUSES = ["pending", "in_flight", "unknown", "succeeded", "failed", "manual_review"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxRow {
  id: number;
  actionId: string;
  tenantId: string;
  idempotencyKey: string;
  bookingNo: string;
  newStatus: string;
  baseVersion: number;
  status: OutboxStatus;
  deliveryAttempts: number;
  reconcileAttempts: number;
  fencingToken: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
  lastError: string | null;
  reviewReason: string | null;
  result: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
}

interface RawRow {
  id: string;
  action_id: string;
  tenant_id: string;
  idempotency_key: string;
  booking_no: string;
  new_status: string;
  base_version: number;
  status: OutboxStatus;
  delivery_attempts: number;
  reconcile_attempts: number;
  fencing_token: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date;
  last_error: string | null;
  review_reason: string | null;
  result: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
}

export const toOutboxRow = (raw: RawRow): OutboxRow => ({
  id: Number(raw.id),
  actionId: raw.action_id,
  tenantId: raw.tenant_id,
  idempotencyKey: raw.idempotency_key,
  bookingNo: raw.booking_no,
  newStatus: raw.new_status,
  baseVersion: raw.base_version,
  status: raw.status,
  deliveryAttempts: raw.delivery_attempts,
  reconcileAttempts: raw.reconcile_attempts,
  fencingToken: Number(raw.fencing_token),
  leaseOwner: raw.lease_owner,
  leaseExpiresAt: raw.lease_expires_at,
  nextAttemptAt: raw.next_attempt_at,
  lastError: raw.last_error,
  reviewReason: raw.review_reason,
  result: raw.result,
  resolution: raw.resolution,
});

/** What a worker holds after winning a claim. Every write it makes must present `token`. */
export interface Claim {
  kind: "deliver" | "reconcile";
  workerId: string;
  token: number;
  row: OutboxRow;
}

export interface OutboxEventView {
  id: number;
  event: string;
  workerId: string | null;
  fencingToken: number | null;
  at: string;
  detail: Record<string, unknown>;
}

export interface Settlement {
  status: OutboxStatus;
  lastError?: string | null;
  reviewReason?: string;
  result?: Record<string, unknown>;
  nextAttemptAt?: Date;
  event: string;
  detail?: Record<string, unknown>;
  /** Extra writes that must commit or roll back together with the status change. */
  alongside?: (client: PoolClient) => Promise<void>;
}

/**
 * Claims and fenced writes over the outbox.
 *
 * **Claims** are single atomic conditional updates (`FOR UPDATE SKIP LOCKED` inside the UPDATE), so two
 * workers polling at once never receive the same row. **Every write a worker makes afterwards** is a
 * conditional update on `(id, fencing_token, lease_owner, expected status)`. A worker that lost its
 * lease — because it stalled, and a sweep plus a newer claim moved on without it — matches zero rows,
 * its write is discarded, and the discard is recorded as a `stale_write_rejected` event. This is the
 * fence at the *application's own* write boundary; it does not reach into the receiver (see
 * `receiver/server.ts` for that boundary's version).
 */
export class OutboxStore {
  public constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async event(client: Pool | PoolClient, row: { id: number; actionId: string }, event: string, workerId: string | null, token: number | null, detail: Record<string, unknown> = {}): Promise<void> {
    await client.query("INSERT INTO outbox_events (outbox_id, action_id, event, worker_id, fencing_token, at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      row.id,
      row.actionId,
      event,
      workerId,
      token,
      this.clock.now(),
      JSON.stringify(detail),
    ]);
  }

  /**
   * Moves every `in_flight` row whose lease has expired to `unknown`. An expired lease says only that
   * the holder has not renewed it — not that the holder has stopped, and not whether it sent the
   * request — so the row is *not* made pending: its outcome must be reconciled first.
   */
  public async sweepExpiredLeases(): Promise<number> {
    const now = this.clock.now();
    return this.tx(async (client) => {
      const { rows } = await client.query<{ id: string; action_id: string; previous_owner: string | null; previous_token: string }>(
        `WITH expired AS (
           SELECT id, lease_owner, fencing_token FROM outbox WHERE status = 'in_flight' AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED)
         UPDATE outbox o SET status = 'unknown', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = $1,
                             last_error = 'lease_expired', updated_at = $1
           FROM expired e WHERE o.id = e.id
         RETURNING o.id, o.action_id, e.lease_owner AS previous_owner, e.fencing_token AS previous_token`,
        [now],
      );
      for (const row of rows) {
        await this.event(client, { id: Number(row.id), actionId: row.action_id }, "lease_expired", row.previous_owner, Number(row.previous_token), { previousOwner: row.previous_owner });
      }
      // An expired *reconciliation* lease keeps the row `unknown`, but its owner is gone: clear it and say so.
      const stale = await client.query<{ id: string; action_id: string; previous_owner: string | null; previous_token: string }>(
        `WITH expired AS (
           SELECT id, lease_owner, fencing_token FROM outbox WHERE status = 'unknown' AND lease_owner IS NOT NULL AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED)
         UPDATE outbox o SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
           FROM expired e WHERE o.id = e.id
         RETURNING o.id, o.action_id, e.lease_owner AS previous_owner, e.fencing_token AS previous_token`,
        [now],
      );
      for (const row of stale.rows) {
        await this.event(client, { id: Number(row.id), actionId: row.action_id }, "lease_expired", row.previous_owner, Number(row.previous_token), { previousOwner: row.previous_owner, during: "reconcile" });
      }
      return rows.length + stale.rows.length;
    });
  }

  /** Reconciliation work first (an unresolved outcome blocks nothing else but should not starve), then new deliveries. */
  public async claimNext(workerId: string, leaseMs: number): Promise<Claim | undefined> {
    return (await this.claim("reconcile", workerId, leaseMs)) ?? (await this.claim("deliver", workerId, leaseMs));
  }

  private async claim(kind: Claim["kind"], workerId: string, leaseMs: number): Promise<Claim | undefined> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const sql =
      kind === "deliver"
        ? `UPDATE outbox SET status = 'in_flight', fencing_token = fencing_token + 1, lease_owner = $1, lease_expires_at = $2,
                             delivery_attempts = delivery_attempts + 1, updated_at = $3
            WHERE id = (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= $3
                         ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
              AND status = 'pending'
            RETURNING *`
        : `UPDATE outbox SET fencing_token = fencing_token + 1, lease_owner = $1, lease_expires_at = $2,
                             reconcile_attempts = reconcile_attempts + 1, updated_at = $3
            WHERE id = (SELECT id FROM outbox WHERE status = 'unknown' AND next_attempt_at <= $3
                           AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
                         ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
              AND status = 'unknown'
            RETURNING *`;
    return this.tx(async (client) => {
      const { rows } = await client.query<RawRow>(sql, [workerId, leaseUntil, now]);
      const raw = rows[0];
      if (!raw) return undefined;
      const row = toOutboxRow(raw);
      await this.event(client, row, `claimed_${kind}`, workerId, row.fencingToken, { attempt: kind === "deliver" ? row.deliveryAttempts : row.reconcileAttempts, leaseExpiresAt: leaseUntil.toISOString() });
      return { kind, workerId, token: row.fencingToken, row };
    });
  }

  /**
   * The fenced write. Applies `settlement` only if the claim's token, owner, and expected status still
   * match the row. Returns `false` — and records the discarded outcome — when they do not.
   */
  public async settle(claim: Claim, settlement: Settlement): Promise<boolean> {
    const expected: OutboxStatus = claim.kind === "deliver" ? "in_flight" : "unknown";
    const now = this.clock.now();
    const accepted = await this.tx(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE outbox SET status = $4, last_error = $5, review_reason = COALESCE($6, review_reason), result = COALESCE($7::jsonb, result),
                           next_attempt_at = COALESCE($8, next_attempt_at), lease_owner = NULL, lease_expires_at = NULL, updated_at = $9
          WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND status = $10`,
        [
          claim.row.id,
          claim.token,
          claim.workerId,
          settlement.status,
          settlement.lastError ?? null,
          settlement.reviewReason ?? null,
          settlement.result === undefined ? null : JSON.stringify(settlement.result),
          settlement.nextAttemptAt ?? null,
          now,
          expected,
        ],
      );
      if (rowCount !== 1) return false;
      await settlement.alongside?.(client);
      await this.event(client, claim.row, settlement.event, claim.workerId, claim.token, { ...settlement.detail, from: expected, to: settlement.status });
      return true;
    });
    if (!accepted) {
      await this.event(this.pool, claim.row, "stale_write_rejected", claim.workerId, claim.token, { discarded: settlement.event, wouldHaveSet: settlement.status });
    }
    return accepted;
  }

  /** Records that a worker stopped because the receiver told it its token was stale. */
  public async recordStaleAtReceiver(claim: Claim): Promise<void> {
    await this.event(this.pool, claim.row, "stale_rejected_by_receiver", claim.workerId, claim.token);
  }

  public async record(claim: Claim, event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.event(this.pool, claim.row, event, claim.workerId, claim.token, detail);
  }

  public async get(id: number): Promise<OutboxRow | undefined> {
    const { rows } = await this.pool.query<RawRow>("SELECT * FROM outbox WHERE id = $1", [id]);
    return rows[0] ? toOutboxRow(rows[0]) : undefined;
  }

  public async getByAction(actionId: string): Promise<OutboxRow | undefined> {
    const { rows } = await this.pool.query<RawRow>("SELECT * FROM outbox WHERE action_id = $1", [actionId]);
    return rows[0] ? toOutboxRow(rows[0]) : undefined;
  }

  public async list(filter: { status?: OutboxStatus; tenantId?: string } = {}): Promise<OutboxRow[]> {
    const { rows } = await this.pool.query<RawRow>(
      "SELECT * FROM outbox WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR tenant_id = $2) ORDER BY id",
      [filter.status ?? null, filter.tenantId ?? null],
    );
    return rows.map(toOutboxRow);
  }

  public async events(outboxId: number): Promise<OutboxEventView[]> {
    const { rows } = await this.pool.query<{ id: string; event: string; worker_id: string | null; fencing_token: string | null; at: Date; detail: Record<string, unknown> }>(
      "SELECT id, event, worker_id, fencing_token, at, detail FROM outbox_events WHERE outbox_id = $1 ORDER BY id",
      [outboxId],
    );
    return rows.map((row) => ({ id: Number(row.id), event: row.event, workerId: row.worker_id, fencingToken: row.fencing_token === null ? null : Number(row.fencing_token), at: row.at.toISOString(), detail: row.detail }));
  }

  /** Whether the row's trail contains any of these events (used to ask "could an earlier attempt have applied?"). */
  public async hasEvent(outboxId: number, events: readonly string[]): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT 1 FROM outbox_events WHERE outbox_id = $1 AND event = ANY($2) LIMIT 1", [outboxId, [...events]]);
    return rows.length > 0;
  }

  /** How many rows are not yet in a state that needs no further work. */
  public async openCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'in_flight', 'unknown')");
    return Number(rows[0]?.n);
  }
}
