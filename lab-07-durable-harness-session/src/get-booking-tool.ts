import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

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

interface GetBookingDetails {
  bookingNo: string;
}

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`Booking not found: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

/**
 * Harness-native tool: `AgentHarnessTool`'s `execute` signature differs from the plain
 * `AgentTool` used by Lab 01/04/05/06's core `Agent` — it takes a progress callback, a
 * resolved tool context, and this call's durable `AgentHarnessToolInvocation` instead of
 * a bare `AbortSignal`. `TContext` is `undefined` here: this lab has no per-turn tool
 * context to resolve.
 */
export function createGetBookingTool(
  repository: BookingRepository,
): AgentHarnessTool<undefined, typeof getBookingParameters, GetBookingDetails> {
  return {
    name: "get_booking",
    label: "Get booking",
    description:
      "Look up one booking by its exact booking number. Use this before making any claim about a booking.",
    parameters: getBookingParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, _context) {
      const booking = repository.findByBookingNo(params.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(params.bookingNo);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(booking) }],
        details: { bookingNo: params.bookingNo },
      };
    },
  };
}
