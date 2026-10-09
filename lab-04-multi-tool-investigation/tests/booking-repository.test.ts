import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";

describe("BookingRepository", () => {
  const repository = BookingRepository.fromDefaultFixture();

  it("returns the fixture booking by its exact booking number", () => {
    expect(repository.findByBookingNo("BK1001")).toEqual({
      bookingNo: "BK1001",
      containerNos: ["MSKU1234567", "MSKU2345678"],
      origin: "CNSHA",
      destination: "NLRTM",
      vessel: "MAERSK TEST",
      plannedDeparture: "2026-09-10T08:00:00Z",
      plannedArrival: "2026-10-15T00:00:00Z",
    });
  });

  it("keeps every container of a multi-container booking, and allows a single-container booking", () => {
    expect(repository.findByBookingNo("BK1001")?.containerNos).toHaveLength(2);
    expect(repository.findByBookingNo("BK1002")?.containerNos).toEqual(["MSKU7654321"]);
  });

  it("returns undefined for an unknown booking", () => {
    expect(repository.findByBookingNo("BAD_ID")).toBeUndefined();
  });
});
