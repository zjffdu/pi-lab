import type { AgentTool } from "@earendil-works/pi-agent-core";
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

export function createGetBookingTool(
  repository: BookingRepository,
): AgentTool<typeof getBookingParameters, GetBookingDetails> {
  return {
    name: "get_booking",
    label: "Get booking",
    description:
      "Look up one booking by its exact booking number. A booking can have several containers: " +
      "returns containerNos (a list) and origin, which are the source of the arguments for " +
      "get_container_events (one call per container) and get_port_status. Call this first.",
    parameters: getBookingParameters,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

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
