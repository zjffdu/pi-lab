import { createHash } from "node:crypto";

/**
 * The key the receiver deduplicates on. It is a pure function of the business action's identity
 * (its ID and the digest the approver confirmed) — not of a worker, an attempt number, a lease, or
 * the time — so every transport retry, every reconciliation redelivery, and every worker restart
 * presents the same key for the same business action. It is also never reused for a different
 * action: the action ID is unique, and the digest binds the exact arguments.
 */
export function idempotencyKey(input: { actionId: string; digest: string }): string {
  return `wb1-${createHash("sha256").update(`lab21|idempotency|v1|${input.actionId}|${input.digest}`).digest("hex").slice(0, 40)}`;
}

/** The request body's hash, for a receiver to detect the same key arriving with different content. */
export function requestHash(request: { tenantId: string; bookingNo: string; newStatus: string; expectedVersion: number }): string {
  return createHash("sha256").update(JSON.stringify([request.tenantId, request.bookingNo, request.newStatus, request.expectedVersion])).digest("hex");
}
