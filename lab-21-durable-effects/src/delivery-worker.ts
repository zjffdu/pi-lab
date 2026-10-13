import type { Pool } from "pg";

import type { Clock } from "./action-service.js";
import { noCheckpoints, type Checkpoints } from "./checkpoints.js";
import { OutboxStore, type Claim, type Settlement } from "./outbox.js";
import type { ReceiverClient } from "./receiver-client.js";
import type { ReceiverContract } from "./receiver/contract.js";

export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 30_000 };
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 4;
export const DEFAULT_MAX_RECONCILE_ATTEMPTS = 4;

export interface DeliveryWorkerOptions {
  workerId: string;
  pool: Pool;
  clock: Clock;
  client: ReceiverClient;
  /**
   * What this application *assumes* about the receiver. It is configuration, not discovery: every
   * effect guarantee below holds only if the real receiver satisfies it. A receiver that ignores
   * idempotency keys while this says `key` will produce duplicate effects — a test pins that down.
   */
  contract: ReceiverContract;
  leaseMs: number;
  maxDeliveryAttempts?: number;
  maxReconcileAttempts?: number;
  backoff?: BackoffPolicy;
  checkpoints?: Checkpoints;
}

export type StepOutcome = { kind: "idle" } | { kind: "worked"; claim: Claim; result: string };

const backoffMs = (policy: BackoffPolicy, attempt: number): number => Math.min(policy.baseMs * 2 ** Math.max(0, attempt - 1), policy.capMs);

/**
 * Delivers outbox entries to the receiver and reconciles the ones whose outcome is unknown.
 *
 * One `runOnce()` = sweep expired leases, claim one row, act on it, record the result with a fenced
 * write. The worker owns retries: the receiver client makes none, so the attempt counter, the backoff,
 * and the choice to reconcile before resending all live in one place.
 *
 * Decision rule, which is the heart of the lab: **a failure to get an answer is never evidence that the
 * effect did not happen.** A timeout, a lost response, a 5xx, or an expired lease make the row
 * `unknown`. Only the receiver's own answer (a delivery response or a status lookup) moves it to
 * `succeeded` or `failed`; only a refused connection proves nothing was sent; and when the receiver
 * offers neither idempotency nor lookup, the row goes to a person rather than being resent blindly.
 */
export class DeliveryWorker {
  private readonly store: OutboxStore;
  private readonly checkpoints: Checkpoints;
  private readonly backoff: BackoffPolicy;
  private readonly maxDelivery: number;
  private readonly maxReconcile: number;

  public constructor(private readonly options: DeliveryWorkerOptions) {
    this.store = new OutboxStore(options.pool, options.clock);
    this.checkpoints = options.checkpoints ?? noCheckpoints;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.maxDelivery = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    this.maxReconcile = options.maxReconcileAttempts ?? DEFAULT_MAX_RECONCILE_ATTEMPTS;
    if (options.leaseMs <= options.client.timeoutMs) {
      throw new Error("The lease must outlive one receiver request, or a live worker can lose its lease mid-request.");
    }
  }

  public get workerId(): string {
    return this.options.workerId;
  }

  public async runOnce(): Promise<StepOutcome> {
    await this.store.sweepExpiredLeases();
    const claim = await this.store.claimNext(this.options.workerId, this.options.leaseMs);
    if (!claim) return { kind: "idle" };
    const context = { worker: this.options.workerId, outboxId: claim.row.id, kind: claim.kind };
    await this.checkpoints.hit("worker.after_claim", context);
    const result = claim.kind === "deliver" ? await this.deliver(claim) : await this.reconcile(claim);
    return { kind: "worked", claim, result };
  }

  /** Steps until nothing is claimable right now, or `maxSteps` is reached. */
  public async runUntilIdle(maxSteps = 100): Promise<number> {
    let worked = 0;
    while (worked < maxSteps) {
      const step = await this.runOnce();
      if (step.kind === "idle") break;
      worked += 1;
    }
    return worked;
  }

  private async commit(claim: Claim, settlement: Settlement): Promise<string> {
    await this.checkpoints.hit("worker.before_result_commit", { worker: claim.workerId, outboxId: claim.row.id, kind: claim.kind });
    const accepted = await this.store.settle(claim, settlement);
    if (accepted) await this.checkpoints.hit("worker.after_result_commit", { worker: claim.workerId, outboxId: claim.row.id, kind: claim.kind });
    return accepted ? settlement.event : `discarded:${settlement.event}`;
  }

  private succeeded(claim: Claim, applied: { newStatus: string; toVersion: number; effectId?: number; replayed?: boolean }, source: "delivery" | "reconciliation"): Promise<string> {
    const { row } = claim;
    return this.commit(claim, {
      status: "succeeded",
      lastError: null,
      result: { source, newStatus: applied.newStatus, toVersion: applied.toVersion, ...(applied.effectId === undefined ? {} : { receiverEffectId: applied.effectId }), ...(applied.replayed === undefined ? {} : { replayed: applied.replayed }) },
      event: "succeeded",
      detail: { source, toVersion: applied.toVersion, ...(applied.replayed === undefined ? {} : { replayed: applied.replayed }) },
      // The durable result and the local booking view change in the same transaction as the status.
      alongside: async (client) => {
        await client.query("UPDATE bookings SET status = $3, version = $4 WHERE tenant_id = $1 AND booking_no = $2", [row.tenantId, row.bookingNo, applied.newStatus, applied.toVersion]);
      },
    });
  }

  private async deliver(claim: Claim): Promise<string> {
    const { row } = claim;
    await this.checkpoints.hit("worker.before_send", { worker: claim.workerId, outboxId: row.id, kind: "deliver" });
    const outcome = await this.options.client.deliver({
      request: { tenantId: row.tenantId, bookingNo: row.bookingNo, newStatus: row.newStatus, expectedVersion: row.baseVersion },
      idempotencyKey: row.idempotencyKey,
      fencingToken: claim.token,
    });
    await this.checkpoints.hit("worker.after_response", { worker: claim.workerId, outboxId: row.id, kind: "deliver" });
    const now = this.options.clock.now();
    const later = (attempt: number) => new Date(now.getTime() + backoffMs(this.backoff, attempt));

    switch (outcome.kind) {
      case "applied":
        return this.succeeded(claim, outcome.response, "delivery");
      case "rejected":
        // A receiver whose record contradicts the key is as untrustworthy as a lookup that disagrees: ask a person.
        if (outcome.code === "idempotency_key_reuse") {
          return this.commit(claim, { status: "manual_review", reviewReason: "receiver_reports_key_reuse_with_different_request", event: "manual_review", detail: { code: outcome.code } });
        }
        return this.commit(claim, { status: "failed", lastError: "rejected_by_receiver", event: "failed", detail: { code: outcome.code, httpStatus: outcome.status } });
      case "stale_fence":
        await this.store.recordStaleAtReceiver(claim);
        return "stale_rejected_by_receiver";
      case "not_sent":
        // The connection was refused: nothing reached the receiver, so waiting and trying again is safe.
        if (row.deliveryAttempts >= this.maxDelivery) {
          // "Refused" describes only *this* attempt. If an earlier attempt was ambiguous (or its lease expired) the
          // effect may exist, so "known not to have happened" — what `failed` means — is not available.
          if (await this.store.hasEvent(row.id, ["outcome_unknown", "lease_expired"])) {
            return this.commit(claim, { status: "manual_review", reviewReason: "retries_exhausted_after_unresolved_attempt", event: "manual_review", detail: { reason: outcome.reason, attempts: row.deliveryAttempts } });
          }
          return this.commit(claim, { status: "failed", lastError: "retries_exhausted", event: "failed", detail: { reason: outcome.reason, attempts: row.deliveryAttempts } });
        }
        return this.commit(claim, { status: "pending", lastError: outcome.reason, nextAttemptAt: later(row.deliveryAttempts), event: "retry_scheduled", detail: { reason: outcome.reason } });
      case "ambiguous":
        // Not "failed" and not "retry": the receiver may have applied it. Reconcile decides.
        return this.commit(claim, { status: "unknown", lastError: outcome.reason, nextAttemptAt: later(row.deliveryAttempts), event: "outcome_unknown", detail: { reason: outcome.reason } });
    }
  }

  private async reconcile(claim: Claim): Promise<string> {
    const { row } = claim;
    const { contract } = this.options;

    const resend = (basis: string): Promise<string> => {
      if (row.deliveryAttempts >= this.maxDelivery) {
        return this.commit(claim, { status: "manual_review", reviewReason: "delivery_attempts_exhausted_outcome_unresolved", event: "manual_review", detail: { basis, attempts: row.deliveryAttempts } });
      }
      // Same idempotency key as every earlier attempt; the receiver's deduplication makes this safe.
      return this.commit(claim, { status: "pending", lastError: row.lastError, nextAttemptAt: this.options.clock.now(), event: "reconciled_resend", detail: { basis } });
    };
    const toReview = (reason: string, detail: Record<string, unknown> = {}): Promise<string> =>
      this.commit(claim, { status: "manual_review", reviewReason: reason, event: "manual_review", detail });

    if (!contract.lookup) {
      return contract.idempotency === "key" ? resend("no_lookup_but_receiver_deduplicates_by_key") : toReview("receiver_has_neither_idempotency_nor_lookup");
    }

    await this.checkpoints.hit("worker.before_send", { worker: claim.workerId, outboxId: row.id, kind: "reconcile" });
    const lookup = await this.options.client.lookup(row.idempotencyKey);
    await this.checkpoints.hit("worker.after_response", { worker: claim.workerId, outboxId: row.id, kind: "reconcile" });

    switch (lookup.kind) {
      case "applied":
        if (lookup.response.bookingNo !== row.bookingNo || lookup.response.newStatus !== row.newStatus) {
          return toReview("lookup_result_does_not_match_request", { reported: { bookingNo: lookup.response.bookingNo, newStatus: lookup.response.newStatus } });
        }
        if (lookup.response.effectCount > 1) {
          return toReview("receiver_reports_multiple_effects_for_this_key", { effectCount: lookup.response.effectCount });
        }
        return this.succeeded(claim, { newStatus: lookup.response.newStatus, toVersion: lookup.response.toVersion }, "reconciliation");
      case "rejected":
        return this.commit(claim, { status: "failed", lastError: "rejected_by_receiver", event: "failed", detail: { code: lookup.code, source: "reconciliation" } });
      case "not_found":
        // "No record now" does not prove "will never have one": the original request may still be in
        // flight. Resending is safe only because the receiver deduplicates by key.
        return contract.idempotency === "key" ? resend("receiver_has_no_record") : toReview("no_receiver_record_but_original_request_may_still_arrive");
      case "unsupported":
        return contract.idempotency === "key" ? resend("lookup_unsupported_but_receiver_deduplicates_by_key") : toReview("contract_violation_lookup_unsupported");
      case "unavailable":
        if (row.reconcileAttempts >= this.maxReconcile) return toReview("reconciliation_exhausted", { lastReason: lookup.reason, attempts: row.reconcileAttempts });
        return this.commit(claim, {
          status: "unknown",
          lastError: `lookup_unavailable:${lookup.reason}`,
          nextAttemptAt: new Date(this.options.clock.now().getTime() + backoffMs(this.backoff, row.reconcileAttempts)),
          event: "reconcile_retry_scheduled",
          detail: { reason: lookup.reason },
        });
    }
  }
}
