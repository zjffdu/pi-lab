import { describe, expect, it } from "vitest";

import { BookingRepository, isBooking } from "../src/booking-repository.js";

describe("BookingRepository", () => {
  const repository = BookingRepository.fromDefaultFixture();

  it("returns a multi-container booking by its exact booking number", () => {
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

  it("returns a single-container booking as a one-element list", () => {
    expect(repository.findByBookingNo("BK1002")?.containerNos).toEqual(["MSKU7654321"]);
  });

  it("returns undefined for an unknown booking", () => {
    expect(repository.findByBookingNo("BAD_ID")).toBeUndefined();
  });
});

describe("isBooking", () => {
  const base = {
    bookingNo: "BK2000",
    origin: "CNSHA",
    destination: "NLRTM",
    vessel: "V",
    plannedDeparture: "2026-09-10",
    plannedArrival: "2026-10-15",
  };

  it("accepts a booking with one or many containers", () => {
    expect(isBooking({ ...base, containerNos: ["MSKU1234567"] })).toBe(true);
    expect(isBooking({ ...base, containerNos: ["MSKU1234567", "MSKU7654321"] })).toBe(true);
  });

  it("rejects a booking whose containers are missing, empty, or not strings", () => {
    expect(isBooking(base)).toBe(false);
    expect(isBooking({ ...base, containerNos: [] })).toBe(false);
    expect(isBooking({ ...base, containerNos: "MSKU1234567" })).toBe(false);
    expect(isBooking({ ...base, containerNos: [42] })).toBe(false);
    expect(isBooking({ ...base, containerNos: [""] })).toBe(false);
    expect(isBooking({ ...base, containerNo: "MSKU1234567" })).toBe(false);
  });
});
