import { createHash } from "node:crypto";

export const ALLOWED_STATUSES = ["booked", "in_transit", "on_hold", "delivered", "cancelled"] as const;
export type BookingStatus = (typeof ALLOWED_STATUSES)[number];

export const ACTION_TYPE = "set_booking_status" as const;
const MAX_REASON_LENGTH = 500;

/** The arguments as a person would review them, after normalization. */
export interface NormalizedArguments {
  bookingNo: string;
  newStatus: BookingStatus;
  reason: string;
}

export class InvalidActionArgumentsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidActionArgumentsError";
  }
}

/**
 * Trims, case-folds, and validates. Two spellings of the same request ("bk1001 " / "BK1001")
 * normalize to one value, so they hash to one digest; anything outside the allowed set is
 * rejected here rather than persisted.
 */
export function normalizeArguments(input: { bookingNo: string; newStatus: string; reason: string }): NormalizedArguments {
  const bookingNo = input.bookingNo.trim().toUpperCase();
  const newStatus = input.newStatus.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!/^[A-Z0-9]{3,20}$/.test(bookingNo)) throw new InvalidActionArgumentsError("bookingNo is not a valid booking number");
  if (!(ALLOWED_STATUSES as readonly string[]).includes(newStatus)) {
    throw new InvalidActionArgumentsError(`newStatus must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  }
  if (reason === "" || reason.length > MAX_REASON_LENGTH) {
    throw new InvalidActionArgumentsError(`reason must be 1-${MAX_REASON_LENGTH} characters`);
  }
  return { bookingNo, newStatus: newStatus as BookingStatus, reason };
}

/** Everything an approval is bound to: who, where, what, and which version of the resource. */
export interface DigestInput {
  tenantId: string;
  requester: string;
  bookingNo: string;
  newStatus: string;
  reason: string;
  baseVersion: number;
}

/** JSON with object keys sorted at every level, so the byte string does not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Version-tagged so a future change to the digest layout cannot collide with today's digests. */
export function actionDigest(input: DigestInput): string {
  const payload = canonicalJson({ v: 1, type: ACTION_TYPE, ...input });
  return createHash("sha256").update(payload).digest("hex");
}
