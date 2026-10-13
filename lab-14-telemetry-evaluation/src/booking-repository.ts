import { readFileSync } from "node:fs";

export const BOOKING_STATUSES = ["booked", "in_transit", "delivered", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface Booking {
  bookingNo: string;
  /** A booking can carry several containers; at least one. */
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  status: BookingStatus;
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === "string" && (BOOKING_STATUSES as readonly string[]).includes(value);
}

export function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasContainers =
    Array.isArray(candidate.containerNos) &&
    candidate.containerNos.length > 0 &&
    candidate.containerNos.every((containerNo) => typeof containerNo === "string" && containerNo !== "");

  return (
    hasContainers &&
    isBookingStatus(candidate.status) &&
    ["bookingNo", "origin", "destination", "vessel", "plannedDeparture", "plannedArrival"].every(
      (field) => typeof candidate[field] === "string",
    )
  );
}

/**
 * Same fixture shape as Labs 01/04/05/07-11 (`containerNos`, never a single `containerNo`), plus the one
 * mutable field Lab 13 added: `status`, and `updateStatus()` — the in-memory effect the
 * `update_booking_status` tool is allowed to have. It never touches `data/bookings.json`; the
 * "duplicated local effect" check needs a real effect to detect a duplicate of.
 */
export class BookingRepository {
  public constructor(private readonly bookings: Booking[]) {}

  public static fromDefaultFixture(): BookingRepository {
    const fixtureUrl = new URL("../data/bookings.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

    if (!Array.isArray(parsed) || !parsed.every(isBooking)) {
      throw new Error("data/bookings.json does not contain a valid booking array");
    }

    return new BookingRepository(parsed);
  }

  public all(): readonly Booking[] {
    return this.bookings;
  }

  public findByBookingNo(bookingNo: string): Booking | undefined {
    return this.bookings.find((booking) => booking.bookingNo === bookingNo);
  }

  /** Throws if the booking does not exist. Callers that want a tool-error instead check `findByBookingNo` first. */
  public updateStatus(bookingNo: string, newStatus: BookingStatus): Booking {
    const booking = this.findByBookingNo(bookingNo);
    if (!booking) {
      throw new Error(`No booking found for: ${bookingNo}`);
    }
    booking.status = newStatus;
    return booking;
  }
}
