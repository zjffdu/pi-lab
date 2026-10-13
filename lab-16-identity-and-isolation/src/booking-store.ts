import type { SecurityContext } from "./security-context.js";
import { assertSecurityContext } from "./security-context.js";
import { loadTenantFixture } from "./directory.js";

export interface Booking {
  tenantId: string;
  bookingNo: string;
  /** A booking can carry several containers; at least one. Its status belongs to the booking, not to a container. */
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  status: string;
}

/**
 * One flat table whose primary key is the composite `(tenantId, bookingNo)` — both tenants own
 * a `BK1001`, so `bookingNo` alone identifies nothing. Every read takes a `SecurityContext` and
 * filters on its `tenantId`; there is deliberately no method that looks a booking up by
 * `bookingNo` without one.
 */
export class TenantBookingStore {
  public constructor(private readonly rows: readonly Booking[]) {}

  public static fromDefaultFixture(): TenantBookingStore {
    return new TenantBookingStore(loadTenantFixture().bookings);
  }

  public findByBookingNo(context: SecurityContext, bookingNo: string): Booking | undefined {
    assertSecurityContext(context);
    const row = this.rows.find((candidate) => candidate.tenantId === context.tenantId && candidate.bookingNo === bookingNo);
    return row ? { ...row } : undefined;
  }

  /**
   * Distinctive values (container number, vessel) that appear in another tenant's rows and in
   * none of the caller's own. Used only by `output-guard.ts` as a last-line detector: if one of
   * these strings shows up in something headed to this caller's provider request or response,
   * scoping failed somewhere upstream. It is a check, never the isolation mechanism itself.
   */
  public foreignMarkers(context: SecurityContext): string[] {
    assertSecurityContext(context);
    const own = new Set<string>();
    const foreign = new Set<string>();
    for (const row of this.rows) {
      const bucket = row.tenantId === context.tenantId ? own : foreign;
      for (const containerNo of row.containerNos) bucket.add(containerNo);
      bucket.add(row.vessel);
    }
    return [...foreign].filter((marker) => !own.has(marker));
  }
}
