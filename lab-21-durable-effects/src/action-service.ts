import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ACTION_TYPE, InvalidActionArgumentsError, actionDigest, normalizeArguments } from "./action-digest.js";
import { fromStates, nextState, type ActionEvent, type ActionState } from "./action-state.js";
import { noCheckpoints, type Checkpoints } from "./checkpoints.js";
import { idempotencyKey } from "./idempotency.js";
import type { Policy } from "./policy.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ActionServiceOptions {
  pool: Pool;
  policy: Policy;
  clock?: Clock;
  /** How long a proposal may wait for a decision. */
  decisionTtlMs?: number;
  /** How long an approval stays usable for execution. */
  approvalTtlMs?: number;
  /** Named failure-injection points (`admit.before_commit`). Defaults to none. */
  checkpoints?: Checkpoints;
}

export const DEFAULT_DECISION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface ApprovalView {
  approver: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/**
 * What the application knows about the delivery of an admitted action. This is the *durable result*
 * layer only — attempts and the receiver's real effects are other layers (see `report.ts`).
 */
export interface DeliveryView {
  outboxId: number;
  status: string;
  idempotencyKey: string;
  deliveryAttempts: number;
  reconcileAttempts: number;
  lastError: string | null;
  reviewReason: string | null;
}

export interface ActionView {
  id: string;
  tenantId: string;
  requester: string;
  bookingNo: string;
  newStatus: string;
  reason: string;
  baseVersion: number;
  digest: string;
  state: ActionState;
  createdAt: string;
  expiresAt: string;
  approval?: ApprovalView;
  delivery?: DeliveryView;
}

export interface EventView {
  event: string;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

/**
 * Why a step was refused. `state` is the action's state after the refusal when it is worth
 * reporting (a stale approval ends `invalidated`; a refused role check leaves the state alone).
 */
export type DenialCode =
  | "not_found"
  | "forbidden"
  | "self_approval"
  | "invalid_state"
  | "expired"
  | "digest_mismatch"
  | "stale_resource"
  | "approver_no_longer_authorized"
  | "requester_no_longer_authorized"
  | "no_change"
  | "already_admitted";

export type StepResult<T> = { ok: true; value: T } | { ok: false; code: DenialCode; state?: ActionState };

const deny = (code: DenialCode, state?: ActionState): { ok: false; code: DenialCode; state?: ActionState } =>
  state === undefined ? { ok: false, code } : { ok: false, code, state };

interface ActionRow {
  id: string;
  tenant_id: string;
  requester: string;
  booking_no: string;
  new_status: string;
  reason: string;
  base_version: number;
  digest: string;
  state: ActionState;
  created_at: Date;
  expires_at: Date;
  approval_id: string | null;
  approver: string | null;
  decision: "approved" | "rejected" | null;
  decided_at: Date | null;
  approval_expires_at: Date | null;
  consumed_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  digest_confirmed: string | null;
  outbox_id: string | null;
  outbox_status: string | null;
  outbox_key: string | null;
  outbox_delivery_attempts: number | null;
  outbox_reconcile_attempts: number | null;
  outbox_last_error: string | null;
  outbox_review_reason: string | null;
}

const SELECT_ACTION = `
  SELECT a.id, a.tenant_id, a.requester, a.booking_no, a.new_status, a.reason, a.base_version, a.digest, a.state,
         a.created_at, a.expires_at,
         p.id AS approval_id, p.approver, p.decision, p.decided_at, p.expires_at AS approval_expires_at,
         p.consumed_at, p.revoked_at, p.revoked_by, p.digest AS digest_confirmed,
         o.id AS outbox_id, o.status AS outbox_status, o.idempotency_key AS outbox_key,
         o.delivery_attempts AS outbox_delivery_attempts, o.reconcile_attempts AS outbox_reconcile_attempts,
         o.last_error AS outbox_last_error, o.review_reason AS outbox_review_reason
    FROM actions a
    LEFT JOIN approvals p ON p.action_id = a.id
    LEFT JOIN outbox o ON o.action_id = a.id`;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toView(row: ActionRow): ActionView {
  const view: ActionView = {
    id: row.id,
    tenantId: row.tenant_id,
    requester: row.requester,
    bookingNo: row.booking_no,
    newStatus: row.new_status,
    reason: row.reason,
    baseVersion: row.base_version,
    digest: row.digest,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
  if (row.approval_id !== null && row.approver !== null && row.decision !== null && row.decided_at !== null) {
    view.approval = {
      approver: row.approver,
      decision: row.decision,
      decidedAt: row.decided_at.toISOString(),
      expiresAt: iso(row.approval_expires_at),
      consumedAt: iso(row.consumed_at),
      revokedAt: iso(row.revoked_at),
      revokedBy: row.revoked_by,
    };
  }
  if (row.outbox_id !== null && row.outbox_status !== null && row.outbox_key !== null) {
    view.delivery = {
      outboxId: Number(row.outbox_id),
      status: row.outbox_status,
      idempotencyKey: row.outbox_key,
      deliveryAttempts: row.outbox_delivery_attempts ?? 0,
      reconcileAttempts: row.outbox_reconcile_attempts ?? 0,
      lastError: row.outbox_last_error,
      reviewReason: row.outbox_review_reason,
    };
  }
  return view;
}

/**
 * Proposal → approval/rejection → admission to the outbox, persisted in PostgreSQL. (Copied from
 * Lab 18's `ActionService`; `execute` became `admit` — see `admit()`.)
 *
 * Every step that changes state runs in one transaction that first takes a row lock on the action
 * (`SELECT … FOR UPDATE`). A second concurrent request for the same action waits for the lock,
 * then sees the state the first one left behind — that is what makes a repeated or simultaneous
 * confirmation admit at most one outbox entry. `outbox.action_id` being UNIQUE is the
 * database-level backstop if that logic were ever wrong.
 *
 * Authorization is asked of `Policy` *inside* the transaction, after the lock, so the role
 * checked is the role held when the step is admitted. Time comes only from the injected clock.
 */
export class ActionService {
  private readonly pool: Pool;
  private readonly policy: Policy;
  private readonly clock: Clock;
  private readonly decisionTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly checkpoints: Checkpoints;

  public constructor(options: ActionServiceOptions) {
    this.pool = options.pool;
    this.policy = options.policy;
    this.clock = options.clock ?? systemClock;
    this.decisionTtlMs = options.decisionTtlMs ?? DEFAULT_DECISION_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.checkpoints = options.checkpoints ?? noCheckpoints;
  }

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

  private async record(client: PoolClient, tenantId: string, actionId: string, event: string, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
    await client.query("INSERT INTO action_events (action_id, tenant_id, event, actor, at, detail) VALUES ($1, $2, $3, $4, $5, $6)", [
      actionId,
      tenantId,
      event,
      actor,
      this.clock.now(),
      JSON.stringify(detail),
    ]);
  }

  private async lock(client: PoolClient, tenantId: string, id: string): Promise<ActionRow | undefined> {
    if (!UUID.test(id)) return undefined;
    // Lock the action row alone, then read the joined view in a second statement. Under READ
    // COMMITTED a single `… JOIN … FOR UPDATE OF a` that had to wait for the lock re-reads `a` at
    // its latest version but keeps the *joined* tables (approvals, outbox) at the statement's
    // original snapshot, so a request that waited behind an approval saw `state = approved` with
    // no approval. The second statement takes a fresh snapshot after the lock is held.
    const locked = await client.query("SELECT 1 FROM actions WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
    if (locked.rowCount !== 1) return undefined;
    const { rows } = await client.query<ActionRow>(`${SELECT_ACTION} WHERE a.tenant_id = $1 AND a.id = $2`, [tenantId, id]);
    return rows[0];
  }

  private async move(client: PoolClient, row: ActionRow, event: ActionEvent, actor: string, detail: Record<string, unknown> = {}): Promise<ActionState> {
    const to = nextState(row.state, event);
    if (to === undefined) throw new Error(`Illegal transition ${event} from ${row.state}`);
    const { rowCount } = await client.query("UPDATE actions SET state = $1 WHERE id = $2 AND state = ANY($3)", [to, row.id, [...fromStates(event)]]);
    if (rowCount !== 1) throw new Error(`Transition ${event} on ${row.id} matched ${rowCount} rows`);
    await this.record(client, row.tenant_id, row.id, event, actor, detail);
    return to;
  }

  /** A refusal that leaves the action as it was but is still worth an audit line. */
  private async refuse(client: PoolClient, row: ActionRow, actor: string, code: DenialCode, step: string) {
    await this.record(client, row.tenant_id, row.id, "denied", actor, { step, code });
    return deny(code);
  }

  /** Moves every action in the tenant whose deadline has passed to `expired`. Called before reads. */
  public async expireDue(tenantId: string): Promise<number> {
    const now = this.clock.now();
    return this.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE actions a SET state = 'expired'
          WHERE a.tenant_id = $1 AND (
            (a.state = 'pending' AND a.expires_at <= $2)
            OR (a.state = 'approved' AND EXISTS (
                  SELECT 1 FROM approvals p
                   WHERE p.action_id = a.id AND p.expires_at <= $2 AND p.consumed_at IS NULL AND p.revoked_at IS NULL)))
        RETURNING a.id`,
        [tenantId, now],
      );
      for (const row of rows) await this.record(client, tenantId, row.id, "expire", "system");
      return rows.length;
    });
  }

  /**
   * Creates an immutable, pending proposal. The base version is read here, by the application —
   * the model supplies only the booking number, target status, and reason.
   */
  public async propose(
    context: SecurityContext,
    input: { bookingNo: string; newStatus: string; reason: string; sessionId?: string },
  ): Promise<StepResult<ActionView>> {
    assertSecurityContext(context);
    if (!this.policy.mayPropose(context)) return deny("forbidden");
    const args = normalizeArguments(input);

    return this.tx(async (client) => {
      const { rows } = await client.query<{ status: string; version: number }>(
        "SELECT status, version FROM bookings WHERE tenant_id = $1 AND booking_no = $2",
        [context.tenantId, args.bookingNo],
      );
      const booking = rows[0];
      if (!booking) return deny("not_found");
      if (booking.status === args.newStatus) return deny("no_change");

      const id = randomUUID();
      const now = this.clock.now();
      const digest = actionDigest({
        tenantId: context.tenantId,
        requester: context.subject,
        bookingNo: args.bookingNo,
        newStatus: args.newStatus,
        reason: args.reason,
        baseVersion: booking.version,
      });
      await client.query(
        `INSERT INTO actions (id, tenant_id, requester, action_type, booking_no, new_status, reason, base_version, digest, state,
                              session_id, request_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13)`,
        [id, context.tenantId, context.subject, ACTION_TYPE, args.bookingNo, args.newStatus, args.reason, booking.version, digest, input.sessionId ?? null, context.requestId, now, new Date(now.getTime() + this.decisionTtlMs)],
      );
      await this.record(client, context.tenantId, id, "propose", context.subject, { requestId: context.requestId, baseVersion: booking.version });
      const created = await client.query<ActionRow>(`${SELECT_ACTION} WHERE a.id = $1`, [id]);
      return { ok: true as const, value: toView(created.rows[0] as ActionRow) };
    });
  }

  private async currentVersion(client: PoolClient, row: ActionRow, forUpdate: boolean): Promise<number | undefined> {
    const { rows } = await client.query<{ version: number }>(
      `SELECT version FROM bookings WHERE tenant_id = $1 AND booking_no = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [row.tenant_id, row.booking_no],
    );
    return rows[0]?.version;
  }

  private digestOf(row: ActionRow): string {
    return actionDigest({
      tenantId: row.tenant_id,
      requester: row.requester,
      bookingNo: row.booking_no,
      newStatus: row.new_status,
      reason: row.reason,
      baseVersion: row.base_version,
    });
  }

  /** Approves the action whose digest the approver reviewed. `digest` must equal the stored one. */
  public async approve(context: SecurityContext, id: string, input: { digest: string }): Promise<StepResult<ActionView>> {
    assertSecurityContext(context);
    return this.decide(context, id, "approve", input.digest);
  }

  public async reject(context: SecurityContext, id: string): Promise<StepResult<ActionView>> {
    assertSecurityContext(context);
    return this.decide(context, id, "reject", undefined);
  }

  private async decide(context: SecurityContext, id: string, kind: "approve" | "reject", digest: string | undefined): Promise<StepResult<ActionView>> {
    return this.tx(async (client) => {
      const row = await this.lock(client, context.tenantId, id);
      if (!row || !this.policy.mayView(context, { tenantId: row.tenant_id, requester: row.requester })) return deny("not_found");

      const authorization = this.policy.mayDecide(context, { tenantId: row.tenant_id, requester: row.requester });
      if (authorization !== "ok") return this.refuse(client, row, context.subject, authorization === "self_approval" ? "self_approval" : "forbidden", kind);
      if (row.state !== "pending") return { ...(await this.refuse(client, row, context.subject, "invalid_state", kind)), state: row.state };

      const now = this.clock.now();
      if (now.getTime() >= row.expires_at.getTime()) {
        await this.move(client, row, "expire", "system", { at: "decision" });
        return deny("expired", "expired");
      }

      if (kind === "approve") {
        if (digest !== row.digest) return this.refuse(client, row, context.subject, "digest_mismatch", kind);
        if (this.digestOf(row) !== row.digest) {
          await this.move(client, row, "invalidate", "system", { reason: "stored arguments no longer match their digest" });
          return deny("digest_mismatch", "invalidated");
        }
        if ((await this.currentVersion(client, row, false)) !== row.base_version) {
          await this.move(client, row, "invalidate", "system", { reason: "booking version changed before approval" });
          return deny("stale_resource", "invalidated");
        }
      }

      await client.query(
        `INSERT INTO approvals (id, action_id, approver, decision, digest, decided_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), row.id, context.subject, kind === "approve" ? "approved" : "rejected", row.digest, now, kind === "approve" ? new Date(now.getTime() + this.approvalTtlMs) : null],
      );
      await this.move(client, row, kind, context.subject);
      return { ok: true as const, value: await this.load(client, row.id) };
    });
  }

  /** Withdraws an approval that has not been consumed yet. */
  public async revoke(context: SecurityContext, id: string): Promise<StepResult<ActionView>> {
    assertSecurityContext(context);
    return this.tx(async (client) => {
      const row = await this.lock(client, context.tenantId, id);
      if (!row || !this.policy.mayView(context, { tenantId: row.tenant_id, requester: row.requester })) return deny("not_found");
      if (!this.policy.mayRevoke(context)) return this.refuse(client, row, context.subject, "forbidden", "revoke");
      if (row.state !== "approved") return { ...(await this.refuse(client, row, context.subject, "invalid_state", "revoke")), state: row.state };

      const { rowCount } = await client.query(
        "UPDATE approvals SET revoked_at = $2, revoked_by = $3 WHERE action_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [row.id, this.clock.now(), context.subject],
      );
      if (rowCount !== 1) return { ...deny("invalid_state"), state: row.state };
      await this.move(client, row, "revoke", context.subject);
      return { ok: true as const, value: await this.load(client, row.id) };
    });
  }

  /**
   * The execution handoff. In one transaction: revalidate everything the approval relied on, consume
   * the approval, record the execution intent (the immutable request, its idempotency key, and the
   * `admitted` state), and insert the outbox entry. **Nothing is sent to the receiver here** — a
   * worker delivers from the outbox later, which is what lets a crash at any point leave a durable,
   * inspectable obligation instead of a half-done call.
   *
   * Refusals leave no outbox row. As in Lab 18, a changed *fact* (deadline, digest, resource version)
   * ends the action; a changed *role* refuses the step and leaves it approved. Repeated or concurrent
   * calls admit exactly one outbox row: the row lock serializes them, `already_admitted` answers the
   * later ones, and `outbox.action_id` UNIQUE is the database backstop.
   */
  public async admit(context: SecurityContext, id: string): Promise<StepResult<ActionView>> {
    assertSecurityContext(context);
    return this.tx(async (client) => {
      const row = await this.lock(client, context.tenantId, id);
      if (!row || !this.policy.mayView(context, { tenantId: row.tenant_id, requester: row.requester })) return deny("not_found");
      if (!this.policy.mayTriggerExecution(context, { tenantId: row.tenant_id, requester: row.requester })) {
        return this.refuse(client, row, context.subject, "forbidden", "admit");
      }
      if (row.state === "admitted") return { ...(await this.refuse(client, row, context.subject, "already_admitted", "admit")), state: row.state };
      if (row.state !== "approved" || row.decision !== "approved" || row.consumed_at !== null || row.revoked_at !== null) {
        return { ...(await this.refuse(client, row, context.subject, "invalid_state", "admit")), state: row.state };
      }

      const now = this.clock.now();
      if (row.approval_expires_at === null || now.getTime() >= row.approval_expires_at.getTime()) {
        await this.move(client, row, "expire", "system", { at: "admission" });
        return deny("expired", "expired");
      }

      const recomputed = this.digestOf(row);
      if (recomputed !== row.digest || recomputed !== row.digest_confirmed) {
        await this.move(client, row, "invalidate", "system", { reason: "arguments do not match the approved digest" });
        return deny("digest_mismatch", "invalidated");
      }

      const parties = { tenantId: row.tenant_id, requester: row.requester };
      if (!this.policy.requesterStillMayPropose(parties)) return this.refuse(client, row, context.subject, "requester_no_longer_authorized", "admit");
      if (row.approver === null || !this.policy.approverStillMayApprove(row.tenant_id, row.approver)) {
        return this.refuse(client, row, context.subject, "approver_no_longer_authorized", "admit");
      }

      // The approval was bound to the *local view's* version. The receiver enforces the same version
      // as a precondition on its side (`expectedVersion`), which is the check that actually protects
      // the remote resource; this one just avoids admitting work already known to be stale.
      const booking = await client.query<{ status: string; version: number }>(
        "SELECT status, version FROM bookings WHERE tenant_id = $1 AND booking_no = $2 FOR UPDATE",
        [row.tenant_id, row.booking_no],
      );
      const current = booking.rows[0];
      if (!current || current.version !== row.base_version) {
        await this.move(client, row, "invalidate", "system", { reason: "booking version changed after approval", expected: row.base_version, actual: current?.version ?? null });
        return deny("stale_resource", "invalidated");
      }

      const consumed = await client.query("UPDATE approvals SET consumed_at = $2 WHERE action_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [row.id, now]);
      if (consumed.rowCount !== 1) throw new Error(`Approval for ${row.id} could not be consumed`);
      const key = idempotencyKey({ actionId: row.id, digest: row.digest });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO outbox (action_id, tenant_id, idempotency_key, booking_no, new_status, base_version, status, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7, $7) RETURNING id`,
        [row.id, row.tenant_id, key, row.booking_no, row.new_status, row.base_version, now],
      );
      const outboxId = Number(inserted.rows[0]?.id);
      await client.query(
        `INSERT INTO outbox_events (outbox_id, action_id, event, at, detail) VALUES ($1, $2, 'admitted', $3, $4)`,
        [outboxId, row.id, now, JSON.stringify({ by: context.subject, idempotencyKey: key, requestId: context.requestId })],
      );
      await this.move(client, row, "admit", context.subject, { outboxId, idempotencyKey: key });
      await this.checkpoints.hit("admit.before_commit", { actionId: row.id });
      return { ok: true as const, value: await this.load(client, row.id) };
    });
  }

  private async load(client: PoolClient, id: string): Promise<ActionView> {
    const { rows } = await client.query<ActionRow>(`${SELECT_ACTION} WHERE a.id = $1`, [id]);
    return toView(rows[0] as ActionRow);
  }

  /** One action the caller may see, with its audit trail; `undefined` if unknown or not theirs. */
  public async get(context: SecurityContext, id: string): Promise<{ action: ActionView; events: EventView[] } | undefined> {
    assertSecurityContext(context);
    if (!UUID.test(id)) return undefined;
    await this.expireDue(context.tenantId);
    const { rows } = await this.pool.query<ActionRow>(`${SELECT_ACTION} WHERE a.tenant_id = $1 AND a.id = $2`, [context.tenantId, id]);
    const row = rows[0];
    if (!row || !this.policy.mayView(context, { tenantId: row.tenant_id, requester: row.requester })) return undefined;
    const events = await this.pool.query<{ event: string; actor: string; at: Date; detail: Record<string, unknown> }>(
      "SELECT event, actor, at, detail FROM action_events WHERE action_id = $1 ORDER BY id",
      [id],
    );
    return { action: toView(row), events: events.rows.map((event) => ({ event: event.event, actor: event.actor, at: event.at.toISOString(), detail: event.detail })) };
  }

  /** The caller's own actions; an approver sees every action in the tenant. */
  public async list(context: SecurityContext, filter: { state?: ActionState } = {}): Promise<ActionView[]> {
    assertSecurityContext(context);
    await this.expireDue(context.tenantId);
    const seesAll = this.policy.mayViewAll(context);
    const { rows } = await this.pool.query<ActionRow>(
      `${SELECT_ACTION} WHERE a.tenant_id = $1 AND ($2::boolean OR a.requester = $3) AND ($4::text IS NULL OR a.state = $4) ORDER BY a.created_at, a.id`,
      [context.tenantId, seesAll, context.subject, filter.state ?? null],
    );
    return rows.map(toView);
  }
}

export { InvalidActionArgumentsError };
