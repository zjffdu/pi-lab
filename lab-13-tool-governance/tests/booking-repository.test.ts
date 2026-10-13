import { describe, expect, it } from "vitest";

import { BookingRepository, isBooking } from "../src/booking-repository.js";

const VALID = {
  bookingNo: "BK9000",
  containerNos: ["MSKU0000001"],
  origin: "CNSHA",
  destination: "NLRTM",
  vessel: "TEST VESSEL",
  plannedDeparture: "2026-09-10",
  plannedArrival: "2026-10-15",
  status: "booked",
};

describe("BookingRepository.fromDefaultFixture", () => {
  it("loads the fixture: a two-container booking, a one-container booking, and one pre-seeded delivered booking", () => {
    const repository = BookingRepository.fromDefaultFixture();

    expect(repository.findByBookingNo("BK1001")).toMatchObject({
      containerNos: ["MSKU1234567", "MSKU2345678"],
      status: "booked",
    });
    expect(repository.findByBookingNo("BK1002")).toMatchObject({ containerNos: ["MSKU7654321"], status: "booked" });
    expect(repository.findByBookingNo("BK1003")).toMatchObject({ status: "delivered" });
    expect(repository.findByBookingNo("BK1003")?.containerNos).toHaveLength(2);
    expect(repository.findByBookingNo("BK9999")).toBeUndefined();
  });

  it("gives every fixture booking at least one container, each container number belonging to exactly one booking", () => {
    const all = BookingRepository.fromDefaultFixture().all();
    const containerNos = all.flatMap((booking) => booking.containerNos);

    expect(all.every((booking) => booking.containerNos.length >= 1)).toBe(true);
    expect(new Set(containerNos).size).toBe(containerNos.length);
  });
});

describe("isBooking", () => {
  it("accepts a one-container and a many-container booking", () => {
    expect(isBooking(VALID)).toBe(true);
    expect(isBooking({ ...VALID, containerNos: ["MSKU0000001", "MSKU0000002", "MSKU0000003"] })).toBe(true);
  });

  it("rejects a booking with no containers", () => {
    expect(isBooking({ ...VALID, containerNos: [] })).toBe(false);
  });

  it("rejects a containerNos entry that is not a non-empty string", () => {
    expect(isBooking({ ...VALID, containerNos: ["MSKU0000001", 42] })).toBe(false);
    expect(isBooking({ ...VALID, containerNos: ["MSKU0000001", ""] })).toBe(false);
    expect(isBooking({ ...VALID, containerNos: "MSKU0000001" })).toBe(false);
  });

  it("rejects the pre-multi-container shape: a single containerNo string", () => {
    const { containerNos: _dropped, ...legacy } = VALID;
    expect(isBooking({ ...legacy, containerNo: "MSKU0000001" })).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(isBooking({ ...VALID, status: "lost-at-sea" })).toBe(false);
  });
});

describe("BookingRepository.updateStatus", () => {
  it("changes the booking's status — one status for the whole booking, however many containers it has", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const updated = repository.updateStatus("BK1001", "in_transit");

    expect(updated.status).toBe("in_transit");
    expect(repository.findByBookingNo("BK1001")?.status).toBe("in_transit");
    expect(updated.containerNos).toEqual(["MSKU1234567", "MSKU2345678"]);
  });

  it("throws for an unknown booking number", () => {
    const repository = BookingRepository.fromDefaultFixture();
    expect(() => repository.updateStatus("BK9999", "in_transit")).toThrow("No booking found for: BK9999");
  });

  it("does not leak into a second repository: each fromDefaultFixture() is its own copy", () => {
    BookingRepository.fromDefaultFixture().updateStatus("BK1001", "in_transit");
    expect(BookingRepository.fromDefaultFixture().findByBookingNo("BK1001")?.status).toBe("booked");
  });
});
