import { describe, expect, it } from "vitest";

import { BookingRepository, isBooking } from "../src/booking-repository.js";

const valid = {
  bookingNo: "BK2000",
  containerNos: ["MSKU0000001"],
  origin: "A",
  destination: "B",
  vessel: "V",
  plannedDeparture: "2026-01-01",
  plannedArrival: "2026-02-01",
  status: "booked",
};

describe("BookingRepository", () => {
  it("loads the default fixture, with BK1001 carrying two containers", () => {
    const repository = BookingRepository.fromDefaultFixture();
    expect(repository.findByBookingNo("BK1001")?.containerNos).toEqual(["MSKU1234567", "MSKU2345678"]);
    expect(repository.findByBookingNo("BK1002")?.containerNos).toEqual(["MSKU7654321"]);
    expect(repository.findByBookingNo("BK1003")?.status).toBe("delivered");
  });

  it("returns undefined for an unknown booking", () => {
    expect(BookingRepository.fromDefaultFixture().findByBookingNo("BK9999")).toBeUndefined();
  });

  it("updateStatus mutates the in-memory booking and returns it", () => {
    const repository = BookingRepository.fromDefaultFixture();
    expect(repository.updateStatus("BK1002", "in_transit").status).toBe("in_transit");
    expect(repository.findByBookingNo("BK1002")?.status).toBe("in_transit");
  });

  it("updateStatus throws for an unknown booking", () => {
    expect(() => BookingRepository.fromDefaultFixture().updateStatus("BK9999", "in_transit")).toThrow(/No booking found/);
  });

  it("two independently loaded repositories do not share mutation state", () => {
    const first = BookingRepository.fromDefaultFixture();
    const second = BookingRepository.fromDefaultFixture();
    first.updateStatus("BK1001", "cancelled");
    expect(second.findByBookingNo("BK1001")?.status).toBe("booked");
  });
});

describe("isBooking", () => {
  it("accepts a booking with one or several containers", () => {
    expect(isBooking(valid)).toBe(true);
    expect(isBooking({ ...valid, containerNos: ["MSKU0000001", "MSKU0000002"] })).toBe(true);
  });

  it("rejects a booking with no containers, an empty container number, or the old single containerNo", () => {
    expect(isBooking({ ...valid, containerNos: [] })).toBe(false);
    expect(isBooking({ ...valid, containerNos: [""] })).toBe(false);
    const { containerNos: _removed, ...legacy } = valid;
    expect(isBooking({ ...legacy, containerNo: "MSKU0000001" })).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(isBooking({ ...valid, status: "lost" })).toBe(false);
  });
});
