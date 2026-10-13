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
 * Read-only, so `replay: "safe"`: re-running it after a crash cannot duplicate an effect. It is the
 * tool every evaluation case's "required tool evidence" check looks for — a case that asks about a
 * booking should show a successful `get_booking` call for that booking number before the answer
 * states a fact about it.
 */
export function createGetBookingTool(repository: BookingRepository) {
  return defineTool({
    name: "get_booking",
    description:
      "Look up one booking's route, vessel, planned dates, current status, and container numbers (one or several). Read-only.",
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
