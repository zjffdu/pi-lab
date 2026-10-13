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
 * A `pi-durable` tool is registered through `defineTool`, not built as a bare `AgentTool`:
 * `execute(args, api, context)` receives validated, typed `args` and a per-call `api`
 * (streamed output, diagnostics, document reads) instead of `(toolCallId, params, signal)`.
 * Each call runs as its own durable task whose intent is committed before `execute()` runs.
 */
export function createGetBookingTool(repository: BookingRepository) {
  return defineTool({
    name: "get_booking",
    description:
      "Look up one booking by its exact booking number. Use this before making any claim about a booking.",
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
