import { loadDirectoryFixture } from "./directory.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface Booking {
  tenantId: string;
  bookingNo: string;
  ownerSubject: string;
  /** A booking can carry several containers (at least one); its status belongs to the booking, not to a container. */
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  status: string;
}

/** What a policy decision may look at: identity and state of the resource, none of its content. */
export interface ResourceView {
  tenantId: string;
  bookingNo: string;
  ownerSubject: string;
  status: string;
}

/** Everything the application layer may do to bookings: read, through a `SecurityContext`. */
export interface BookingReader {
  describe(context: SecurityContext, bookingNo: string): ResourceView | undefined;
  find(context: SecurityContext, bookingNo: string): Booking | undefined;
}

export interface StatusChange {
  tenantId: string;
  bookingNo: string;
  from: string;
  to: string;
  actorSubject: string;
}

/**
 * The booking system of record. The application layer is handed only the `BookingReader`
 * interface — it has no method that mutates a booking. Writes reach the store only through the
 * downstream service (`downstream-service.ts`), which is the simulated business effect and the
 * place `statusChanges` is recorded. Both tenants own a `BK1001`: the primary key is the
 * composite `(tenantId, bookingNo)`.
 */
export class BookingStore implements BookingReader {
  private readonly rows: Booking[];
  public readonly statusChanges: StatusChange[] = [];

  public constructor(rows: readonly Booking[]) {
    this.rows = rows.map((row) => ({ ...row, containerNos: [...row.containerNos] }));
  }

  public static fromDefaultFixture(): BookingStore {
    return new BookingStore(loadDirectoryFixture().bookings);
  }

  public describe(context: SecurityContext, bookingNo: string): ResourceView | undefined {
    assertSecurityContext(context);
    const row = this.lookup(context.tenantId, bookingNo);
    return row ? { tenantId: row.tenantId, bookingNo: row.bookingNo, ownerSubject: row.ownerSubject, status: row.status } : undefined;
  }

  public find(context: SecurityContext, bookingNo: string): Booking | undefined {
    assertSecurityContext(context);
    const row = this.lookup(context.tenantId, bookingNo);
    return row ? { ...row, containerNos: [...row.containerNos] } : undefined;
  }

  /** Distinctive values that identify one booking — every container number and the vessel — for tests asserting "this never reached the provider". */
  public markersFor(tenantId: string, bookingNo: string): string[] {
    const row = this.lookup(tenantId, bookingNo);
    return row ? [...row.containerNos, row.vessel] : [];
  }

  // --- Downstream-system surface: called only by `downstream-service.ts`, with an identity taken
  // from a verified delegated token, never from the application's own SecurityContext. ---

  public downstreamFind(tenantId: string, bookingNo: string): Booking | undefined {
    const row = this.lookup(tenantId, bookingNo);
    return row ? { ...row, containerNos: [...row.containerNos] } : undefined;
  }

  public downstreamSetStatus(tenantId: string, bookingNo: string, to: string, actorSubject: string): StatusChange {
    const row = this.lookup(tenantId, bookingNo);
    if (!row) throw new Error("booking vanished");
    const change: StatusChange = { tenantId, bookingNo, from: row.status, to, actorSubject };
    row.status = to;
    this.statusChanges.push(change);
    return change;
  }

  private lookup(tenantId: string, bookingNo: string): Booking | undefined {
    return this.rows.find((row) => row.tenantId === tenantId && row.bookingNo === bookingNo);
  }
}
