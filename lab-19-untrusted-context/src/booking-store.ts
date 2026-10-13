import type { Booking } from "./directory.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * Tenant-scoped bookings. Only the two operations this lab needs — checking that a booking exists
 * for the caller's tenant (proposal target, outbound-tool subject) and reading its status.
 * Colliding booking numbers across tenants (`BK1001` exists in both) resolve by the caller's tenant.
 */
export class TenantBookingStore {
  private readonly byKey = new Map<string, Booking>();

  public constructor(bookings: readonly Booking[]) {
    for (const booking of bookings) this.byKey.set(JSON.stringify([booking.tenantId, booking.bookingNo]), booking);
  }

  public find(context: SecurityContext, bookingNo: string): Booking | undefined {
    assertSecurityContext(context);
    return this.byKey.get(JSON.stringify([context.tenantId, bookingNo]));
  }

  public statusSnapshot(): string {
    return JSON.stringify([...this.byKey.values()].map((booking) => [booking.tenantId, booking.bookingNo, booking.status]));
  }
}
