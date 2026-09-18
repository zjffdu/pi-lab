import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";

describe("BookingRepository", () => {
  const repository = BookingRepository.fromDefaultFixture();

  it("returns the fixture booking by its exact booking number", () => {
    expect(repository.findByBookingNo("BK1001")).toEqual({
      bookingNo: "BK1001",
      containerNo: "MSKU1234567",
      origin: "CNSHA",
      destination: "NLRTM",
      vessel: "MAERSK TEST",
      plannedDeparture: "2026-09-10",
      plannedArrival: "2026-10-15",
    });
  });

  it("returns the customsHoldReason for the one booking that has it, absent from the other", () => {
    expect(repository.findByBookingNo("BK1002")?.customsHoldReason).toBe("missing phytosanitary certificate");
    expect(repository.findByBookingNo("BK1001")?.customsHoldReason).toBeUndefined();
  });

  it("returns undefined for an unknown booking", () => {
    expect(repository.findByBookingNo("BAD_ID")).toBeUndefined();
  });
});
