import { readFileSync } from "node:fs";

export interface Booking {
  bookingNo: string;
  containerNo: string;
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
  /** Present only for a booking with a known hold. This lab's one "vulnerable early fact":
   * it is established once, early in the seeded conversation, and never repeated. */
  customsHoldReason?: string;
}

function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const requiredFieldsOk = [
    "bookingNo",
    "containerNo",
    "origin",
    "destination",
    "vessel",
    "plannedDeparture",
    "plannedArrival",
  ].every((field) => typeof candidate[field] === "string");

  return requiredFieldsOk && (candidate.customsHoldReason === undefined || typeof candidate.customsHoldReason === "string");
}

export class BookingRepository {
  public constructor(private readonly bookings: readonly Booking[]) {}

  public static fromDefaultFixture(): BookingRepository {
    const fixtureUrl = new URL("../data/bookings.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

    if (!Array.isArray(parsed) || !parsed.every(isBooking)) {
      throw new Error("data/bookings.json does not contain a valid booking array");
    }

    return new BookingRepository(parsed);
  }

  public findByBookingNo(bookingNo: string): Booking | undefined {
    return this.bookings.find((booking) => booking.bookingNo === bookingNo);
  }
}
