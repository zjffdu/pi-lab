import { readFileSync } from "node:fs";

export interface Booking {
  bookingNo: string;
  containerNos: string[];
  origin: string;
  destination: string;
  vessel: string;
  plannedDeparture: string;
  plannedArrival: string;
}

function isBooking(value: unknown): value is Booking {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.containerNos) &&
    candidate.containerNos.every((containerNo) => typeof containerNo === "string") &&
    ["bookingNo", "origin", "destination", "vessel", "plannedDeparture", "plannedArrival"].every(
      (field) => typeof candidate[field] === "string",
    )
  );
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
