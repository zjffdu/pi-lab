import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { BookingService } from "./booking-service.js";
import { READ_TOOL_NAME } from "./capability-resolver.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * One parameter. There is no tenant, subject, or role field, and `additionalProperties: false`
 * makes the harness refuse a model that invents one (diagnostic `invalid_arguments`) — the principal
 * is closed over from the server-created `SecurityContext` when the tool is built.
 */
const parameters = Type.Object(
  { bookingNo: Type.String({ description: "Exact booking number, for example BK1001", minLength: 1 }) },
  { additionalProperties: false },
);

/**
 * Declared `replay: "safe"`: a rerun after a crash reads the same booking and changes nothing, so
 * recovery may execute it again — through this same function, which is why a rerun is authorized
 * against *today's* roles and ownership, not those of the process that died.
 */
export function createGetBookingTool(context: SecurityContext, service: BookingService) {
  assertSecurityContext(context);
  return defineTool({
    name: READ_TOOL_NAME,
    description:
      "Look up one of the bookings you are permitted to see: route, vessel, planned dates, container numbers (one or several), and status. Read-only.",
    parameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(args, api) {
      const booking = await service.read(context, args.bookingNo, { channel: "tool", toolCallId: api.callId });
      return { content: [{ type: "text", text: JSON.stringify(booking) }], details: { bookingNo: args.bookingNo } };
    },
  });
}
