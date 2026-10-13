import type { Pool } from "pg";

import { OutboxStore, type OutboxEventView } from "./outbox.js";

/**
 * One action's outcome, in three layers that must not be conflated:
 *
 *  - **attempts** — how often the application tried. From the outbox events (claims) it is the
 *    application's own count; `receiverSawRequests` is the receiver's count of requests that actually
 *    arrived. They differ when a request never reaches the receiver or a claim ends before sending.
 *  - **business effects** — how many times the downstream booking actually changed. Only the
 *    receiver knows; this function reads it from the receiver's tables, which the *application* could
 *    not do in production (it would have to ask the receiver's status interface, and can only if the
 *    receiver has one). It exists so tests and the demo can check the application's belief against
 *    ground truth.
 *  - **durable result** — what the application has recorded: the outbox status and the local view.
 *
 * `consistent` is true when the application's durable result agrees with ground truth. A `pending`,
 * `in_flight`, `unknown`, or `manual_review` row is honest by construction about not knowing.
 */
export interface EffectReport {
  actionId: string;
  idempotencyKey: string;
  attempts: {
    deliveryClaims: number;
    reconcileClaims: number;
    leaseExpiries: number;
    staleWritesRejected: number;
    receiverSawRequests: number;
    receiverSawLookups: number;
  };
  businessEffects: { appliedCount: number; receiverVersion: number | null };
  durableResult: { outboxStatus: string; lastError: string | null; reviewReason: string | null; localViewStatus: string | null; localViewVersion: number | null };
  consistent: boolean;
  inconsistency?: string;
  events: OutboxEventView[];
}

export async function buildEffectReport(appPool: Pool, receiverPool: Pool, actionId: string): Promise<EffectReport | undefined> {
  const store = new OutboxStore(appPool, { now: () => new Date() });
  const row = await store.getByAction(actionId);
  if (!row) return undefined;
  const events = await store.events(row.id);
  const count = (event: string) => events.filter((entry) => entry.event === event).length;

  const seen = await receiverPool.query<{ kind: string; n: string }>("SELECT kind, count(*) AS n FROM receiver_requests WHERE request_ref = $1 GROUP BY kind", [row.idempotencyKey]);
  const seenOf = (kind: string) => Number(seen.rows.find((entry) => entry.kind === kind)?.n ?? 0);
  const effects = await receiverPool.query<{ n: string }>("SELECT count(*) AS n FROM receiver_effects WHERE request_ref = $1", [row.idempotencyKey]);
  const receiverBooking = await receiverPool.query<{ version: number }>("SELECT version FROM receiver_bookings WHERE tenant_id = $1 AND booking_no = $2", [row.tenantId, row.bookingNo]);
  const local = await appPool.query<{ status: string; version: number }>("SELECT status, version FROM bookings WHERE tenant_id = $1 AND booking_no = $2", [row.tenantId, row.bookingNo]);

  const appliedCount = Number(effects.rows[0]?.n);
  let inconsistency: string | undefined;
  if (appliedCount > 1) inconsistency = `duplicate business effect: the receiver applied this action ${appliedCount} times`;
  else if (row.status === "succeeded" && appliedCount !== 1) inconsistency = "recorded as succeeded but the receiver has no effect";
  else if (row.status === "failed" && appliedCount !== 0) inconsistency = "recorded as failed but the receiver applied an effect";

  return {
    actionId,
    idempotencyKey: row.idempotencyKey,
    attempts: {
      deliveryClaims: count("claimed_deliver"),
      reconcileClaims: count("claimed_reconcile"),
      leaseExpiries: count("lease_expired"),
      staleWritesRejected: count("stale_write_rejected"),
      receiverSawRequests: seenOf("deliver"),
      receiverSawLookups: seenOf("lookup"),
    },
    businessEffects: { appliedCount, receiverVersion: receiverBooking.rows[0]?.version ?? null },
    durableResult: { outboxStatus: row.status, lastError: row.lastError, reviewReason: row.reviewReason, localViewStatus: local.rows[0]?.status ?? null, localViewVersion: local.rows[0]?.version ?? null },
    consistent: inconsistency === undefined,
    ...(inconsistency === undefined ? {} : { inconsistency }),
    events,
  };
}
