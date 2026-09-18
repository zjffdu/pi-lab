import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";

describe("BookingRepository", () => {
  const repository = BookingRepository.fromDefaultFixture();

  it("returns BK1001 by its exact booking number", () => {
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

  it("returns BK1002, the fixture this lab's case notes also reference", () => {
    expect(repository.findByBookingNo("BK1002")).toEqual({
      bookingNo: "BK1002",
      containerNo: "MSKU7654321",
      origin: "SGSIN",
      destination: "USLAX",
      vessel: "MAERSK SECOND",
      plannedDeparture: "2026-09-12",
      plannedArrival: "2026-10-02",
    });
  });

  it("returns undefined for an unknown booking", () => {
    expect(repository.findByBookingNo("BAD_ID")).toBeUndefined();
  });
});
