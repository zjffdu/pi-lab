import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import { BOOKING_STATUSES, type BookingRepository } from "./booking-repository.js";
import { BookingNotFoundError } from "./get-booking-tool.js";

export const updateBookingStatusParameters = Type.Object(
  {
    bookingNo: Type.String({
      description: "Exact booking number, for example BK1001",
      minLength: 1,
    }),
    // An explicit tuple, not `BOOKING_STATUSES.map(...)`: a mapped array is not a tuple, so `Static<>` would
    // infer `never` for `args.newStatus`. tests/tools.test.ts keeps this list in step with BOOKING_STATUSES.
    newStatus: Type.Union(
      [Type.Literal("booked"), Type.Literal("in_transit"), Type.Literal("delivered"), Type.Literal("cancelled")],
      { description: "One of: " + BOOKING_STATUSES.join(", ") },
    ),
  },
  { additionalProperties: false },
);

/**
 * This lab's one local, state-changing tool, always active and ungoverned (governance is Lab 13's
 * concern). It exists so the "duplicated local effect" check has a real mutation to catch a
 * duplicate of: a case that asks for exactly one status change must show exactly one executed
 * `update_booking_status` call for that booking, not two.
 *
 * `replay: "unsafe"` — a state-changing tool must not be re-run by crash recovery (Lab 09). Its only
 * effect is a synchronous in-memory mutation, never a real shipment update.
 */
export function createUpdateBookingStatusTool(repository: BookingRepository) {
  return defineTool({
    name: "update_booking_status",
    description: "Change one booking's status. State-changing: call it at most once per requested change.",
    parameters: updateBookingStatusParameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(args) {
      const booking = repository.findByBookingNo(args.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(args.bookingNo);
      }

      const previousStatus = booking.status;
      repository.updateStatus(args.bookingNo, args.newStatus);

      return {
        content: [
          { type: "text", text: JSON.stringify({ bookingNo: args.bookingNo, previousStatus, newStatus: args.newStatus }) },
        ],
        details: { bookingNo: args.bookingNo, previousStatus, newStatus: args.newStatus },
      };
    },
  });
}
