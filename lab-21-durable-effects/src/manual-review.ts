import type { Pool } from "pg";

import type { Clock } from "./action-service.js";
import { OutboxStore, toOutboxRow, type OutboxRow } from "./outbox.js";
import type { Policy } from "./policy.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export type Resolution =
  /** A person checked the downstream system and found the effect there. */
  | { kind: "confirmed_applied"; toVersion: number; note: string }
  /** A person checked and found no effect, and does not want it retried. */
  | { kind: "confirmed_not_applied"; note: string }
  /** Put it back in the queue. `acceptDuplicateRisk` must be true: the receiver cannot prove a resend is safe. */
  | { kind: "redeliver"; note: string; acceptDuplicateRisk: boolean };

export type ReviewDenial = "not_found" | "forbidden" | "self_resolution" | "not_in_review" | "note_required" | "risk_not_accepted";
export type ReviewResult = { ok: true; row: OutboxRow } | { ok: false; code: ReviewDenial };

const deny = (code: ReviewDenial): ReviewResult => ({ ok: false, code });

/**
 * The manual path for outcomes the application refuses to guess about. It changes an outbox row only
 * from `manual_review`, only through an authenticated approver who is not the requester, and only with
 * a written note; the change and its audit event commit together. It never talks to the receiver — a
 * person does that, using the runbook, and reports what they found.
 */
export class ManualReview {
  private readonly store: OutboxStore;

  public constructor(
    private readonly pool: Pool,
    private readonly policy: Policy,
    private readonly clock: Clock,
  ) {
    this.store = new OutboxStore(pool, clock);
  }

  /** Rows awaiting review in the caller's tenant; an empty list for anyone who may not review. */
  public async list(context: SecurityContext): Promise<OutboxRow[]> {
    assertSecurityContext(context);
    if (this.policy.mayViewAll(context) === false) return [];
    return this.store.list({ status: "manual_review", tenantId: context.tenantId });
  }

  public async resolve(context: SecurityContext, outboxId: number, resolution: Resolution): Promise<ReviewResult> {
    assertSecurityContext(context);
    if (resolution.note.trim() === "") return deny("note_required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<Parameters<typeof toOutboxRow>[0] & { requester: string }>(
        `SELECT o.*, a.requester FROM outbox o JOIN actions a ON a.id = o.action_id WHERE o.id = $1 AND o.tenant_id = $2 FOR UPDATE OF o`,
        [outboxId, context.tenantId],
      );
      const found = locked.rows[0];
      if (!found) {
        await client.query("ROLLBACK");
        return deny("not_found");
      }
      const row = toOutboxRow(found);
      const authorization = this.policy.mayResolveReview(context, { tenantId: row.tenantId, requester: found.requester });
      if (authorization !== "ok") {
        await client.query("ROLLBACK");
        return deny(authorization === "self_resolution" ? "self_resolution" : "forbidden");
      }
      if (row.status !== "manual_review") {
        await client.query("ROLLBACK");
        return deny("not_in_review");
      }
      if (resolution.kind === "redeliver" && !resolution.acceptDuplicateRisk) {
        await client.query("ROLLBACK");
        return deny("risk_not_accepted");
      }

      const now = this.clock.now();
      let viewUpdated: boolean | undefined;
      const record = { by: context.subject, requestId: context.requestId, ...resolution };
      if (resolution.kind === "confirmed_applied") {
        await client.query(
          `UPDATE outbox SET status = 'succeeded', last_error = NULL, review_reason = NULL, result = $2, resolution = $3, updated_at = $4 WHERE id = $1`,
          [row.id, JSON.stringify({ source: "manual_review", newStatus: row.newStatus, toVersion: resolution.toVersion }), JSON.stringify(record), now],
        );
        // The reviewer's report is recorded either way, but the local view only ever moves forward: an
        // older action resolved late must not roll back a newer durable result.
        const moved = await client.query("UPDATE bookings SET status = $3, version = $4 WHERE tenant_id = $1 AND booking_no = $2 AND version < $4", [row.tenantId, row.bookingNo, row.newStatus, resolution.toVersion]);
        viewUpdated = moved.rowCount === 1;
      } else if (resolution.kind === "confirmed_not_applied") {
        await client.query(`UPDATE outbox SET status = 'failed', last_error = 'manual_confirmed_not_applied', review_reason = NULL, resolution = $2, updated_at = $3 WHERE id = $1`, [row.id, JSON.stringify(record), now]);
      } else {
        await client.query(`UPDATE outbox SET status = 'pending', next_attempt_at = $3, review_reason = NULL, resolution = $2, updated_at = $3 WHERE id = $1`, [row.id, JSON.stringify(record), now]);
      }
      await client.query("INSERT INTO outbox_events (outbox_id, action_id, event, at, detail) VALUES ($1, $2, $3, $4, $5)", [
        row.id,
        row.actionId,
        `manual_${resolution.kind}`,
        now,
        JSON.stringify({ by: context.subject, note: resolution.note, reviewReason: row.reviewReason, ...(viewUpdated === undefined ? {} : { localViewUpdated: viewUpdated }) }),
      ]);
      await client.query("COMMIT");
      const updated = await this.store.get(row.id);
      return { ok: true, row: updated as OutboxRow };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
