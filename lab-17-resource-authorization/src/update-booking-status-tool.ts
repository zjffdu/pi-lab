import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { BookingService } from "./booking-service.js";
import { WRITE_TOOL_NAME } from "./capability-resolver.js";
import { EDITABLE_TARGET_STATUSES } from "./policy.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

const parameters = Type.Object(
  {
    bookingNo: Type.String({ description: "Exact booking number, for example BK1001", minLength: 1 }),
    newStatus: Type.Union(
      EDITABLE_TARGET_STATUSES.map((status) => Type.Literal(status)),
      { description: `One of: ${EDITABLE_TARGET_STATUSES.join(", ")}` },
    ),
  },
  { additionalProperties: false },
);

/**
 * The one simulated write. Its structural limits (which strings `newStatus` may be, no principal
 * parameter) live in the schema; whether *this* caller may change *this* booking *now* is decided
 * in `BookingService`, on every execution. The status belongs to the booking as a whole, however many
 * containers it carries. `replay: "unsafe"` — recovery will not re-run it; a write whose outcome is
 * unknown after a crash is Lab 21's problem, not this lab's.
 */
export function createUpdateBookingStatusTool(context: SecurityContext, service: BookingService) {
  assertSecurityContext(context);
  return defineTool({
    name: WRITE_TOOL_NAME,
    description:
      "Change the status of one of your own bookings (booked, on_hold, cancelled) — the booking as a whole, not one container. Some changes are refused by the system regardless of how they are requested.",
    parameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(args, api) {
      const result = await service.updateStatus(context, { bookingNo: args.bookingNo, newStatus: args.newStatus }, { channel: "tool", toolCallId: api.callId });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
    },
  });
}
