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
  found: boolean;
}

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`No booking found for: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

/**
 * Read-only, declared `replay: "safe"` — this lab is not about recovery (Lab 08/09), but a
 * tool result is still durable session evidence, and it is what makes each branch's booking
 * facts something `navigateTree()`'s contrast case can actually verify per branch.
 */
export function createGetBookingTool(
  repository: BookingRepository,
): AgentHarnessTool<undefined, typeof getBookingParameters, GetBookingDetails> {
  return {
    name: "get_booking",
    label: "Get booking",
    description: "Look up one booking's route, vessel, and planned dates. Read-only.",
    parameters: getBookingParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(_toolCallId, params) {
      const booking = repository.findByBookingNo(params.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(params.bookingNo);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(booking) }],
        details: { bookingNo: params.bookingNo, found: true },
      };
    },
  };
}
