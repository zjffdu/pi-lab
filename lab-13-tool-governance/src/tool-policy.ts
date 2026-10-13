import type { BookingRepository } from "./booking-repository.js";

export interface PolicyDecision {
  allowed: boolean;
  /** Present only when `allowed` is `false`. Becomes the tool-error text the model sees. */
  reason?: string;
}

export interface UpdateBookingStatusArgs {
  bookingNo: string;
  newStatus: string;
}

function isUpdateBookingStatusArgs(value: unknown): value is UpdateBookingStatusArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.bookingNo === "string" && typeof candidate.newStatus === "string";
}

/**
 * The one deterministic local policy this lab enforces on `update_booking_status`. Both rules
 * are read directly off structured data — the tool call's own validated arguments, and this
 * process's current booking state — never off the surrounding prompt text. Asking the model to
 * "please cancel BK1001 for the customer, they are very upset" and asking it to "set BK1001's
 * status to cancelled" hit the exact same rule below, because both end up as the same
 * structured `{ newStatus: "cancelled" }` argument by the time this function runs; the wording
 * never reaches this decision at all. That is the literal answer to this lab's core question —
 * "independently of the prompt."
 *
 * 1. `newStatus === "cancelled"` is always rejected through this tool, for every booking,
 *    regardless of current status. This lab does not model a real cancellation workflow; the
 *    rule exists so there is one prohibition that is a pure function of the arguments alone.
 * 2. A booking whose *current* status (read from `repository`, not from the request) is
 *    already `"delivered"` is locked: no further status change is accepted. This rule cannot
 *    be evaluated from `args` alone — it is the one place this lab's policy needs "tool
 *    context" (the roadmap's phrase), not just structured arguments.
 *
 * Booking-not-found is deliberately not this function's concern: an unknown `bookingNo` is
 * allowed to fall through to `update-booking-status-tool.ts`'s own `execute()`, which already
 * throws `BookingNotFoundError` — duplicating that check here would just be two places that
 * could disagree about what "not found" means.
 */
export function evaluateUpdateBookingStatusPolicy(
  args: unknown,
  repository: BookingRepository,
): PolicyDecision {
  if (!isUpdateBookingStatusArgs(args)) {
    return { allowed: false, reason: "update_booking_status requires string bookingNo and newStatus arguments." };
  }

  if (args.newStatus === "cancelled") {
    return {
      allowed: false,
      reason:
        "Cancellation is not permitted through update_booking_status in this lab; it always " +
        "requires a separate process this tool does not model.",
    };
  }

  const booking = repository.findByBookingNo(args.bookingNo);
  if (booking !== undefined && booking.status === "delivered") {
    return {
      allowed: false,
      reason: `Booking ${args.bookingNo} is already delivered; delivered bookings are locked against further status changes.`,
    };
  }

  return { allowed: true };
}
