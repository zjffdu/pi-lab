import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { Booking, TenantBookingStore } from "./booking-store.js";
import type { ScopedCache } from "./scoped-cache.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * The only parameter is `bookingNo`. There is no tenant, user, or role parameter to fill in, and
 * `additionalProperties: false` makes the harness refuse a call that invents one (`invalid_arguments`,
 * before `execute()` ever runs) — the principal is closed over from the server-created `SecurityContext`
 * when the tool is built, never read from arguments.
 */
const getBookingParameters = Type.Object(
  {
    bookingNo: Type.String({ description: "Exact booking number, for example BK1001", minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * Same text for "no such booking" and "that booking belongs to another tenant": the lookup is already
 * filtered by tenant, so the two cases are the same event, and the message can only say what the caller's
 * own tenant contains.
 */
export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`No booking found for: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

export function createGetBookingTool(context: SecurityContext, store: TenantBookingStore, cache: ScopedCache<Booking>) {
  assertSecurityContext(context);
  return defineTool({
    name: "get_booking",
    description:
      "Look up one of your organization's bookings: route, vessel, planned dates, container numbers (one or several), and status. Read-only.",
    parameters: getBookingParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(args) {
      const scope = { tenantId: context.tenantId };
      let booking = cache.get(scope, args.bookingNo);
      if (!booking) {
        booking = store.findByBookingNo(context, args.bookingNo);
        if (booking) cache.set(scope, args.bookingNo, booking);
      }
      if (!booking) throw new BookingNotFoundError(args.bookingNo);

      return {
        content: [{ type: "text", text: JSON.stringify(booking) }],
        details: { tenantId: context.tenantId, bookingNo: args.bookingNo },
      };
    },
  });
}
