import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { BookingRepository } from "./booking-repository.js";

const getBookingParameters = Type.Object(
  {
    bookingNo: Type.String({
      description: "Exact booking number, for example BK1001",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`Booking not found: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

/**
 * Read-only and ungoverned: no hook looks at it. It stays offered in every scenario so there is always
 * one ordinary tool to contrast with `update_booking_status`, the one governed, state-changing tool.
 * Declared `replay: "safe"` — a rerun after a crash reads the same fixture and changes nothing.
 */
export function createGetBookingTool(repository: BookingRepository) {
  return defineTool({
    name: "get_booking",
    description:
      "Look up one booking's route, vessel, planned dates, container numbers (one or several), and current status. Read-only.",
    parameters: getBookingParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(args) {
      const booking = repository.findByBookingNo(args.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(args.bookingNo);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(booking) }],
        details: { bookingNo: args.bookingNo },
      };
    },
  });
}
