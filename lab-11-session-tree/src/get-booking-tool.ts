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
 * Read-only. Its result is the durable `pi.tool-result` entry that makes each branch's booking
 * facts something the lab can check per branch: BK1001's vessel only ever appears in the branch
 * that looked BK1001 up, and BK1002's only in the branch that looked BK1002 up.
 */
export function createGetBookingTool(repository: BookingRepository) {
  return defineTool({
    name: "get_booking",
    description:
      "Look up one booking's route, vessel, planned dates, and container numbers (one or several). Read-only.",
    parameters: getBookingParameters,
    executionMode: "sequential",
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
