import { describe, expect, it } from "vitest";

import { isBooking, loadTenantFixture } from "../src/directory.js";

const valid = {
  tenantId: "tenant-a",
  bookingNo: "BK1",
  containerNos: ["MSKU1"],
  origin: "A",
  destination: "B",
  vessel: "V",
  plannedDeparture: "2026-01-01",
  plannedArrival: "2026-01-02",
  status: "booked",
};

describe("isBooking — a booking carries one or several containers", () => {
  it("accepts one container and several", () => {
    expect(isBooking(valid)).toBe(true);
    expect(isBooking({ ...valid, containerNos: ["MSKU1", "MSKU2", "MSKU3"] })).toBe(true);
  });

  it("rejects a missing, empty, non-array, or blank-entry container list", () => {
    const { containerNos: _omitted, ...withoutContainers } = valid;
    expect(isBooking(withoutContainers)).toBe(false);
    expect(isBooking({ ...valid, containerNos: [] })).toBe(false);
    expect(isBooking({ ...valid, containerNos: "MSKU1" })).toBe(false);
    expect(isBooking({ ...valid, containerNos: ["MSKU1", ""] })).toBe(false);
    expect(isBooking({ ...valid, containerNos: ["MSKU1", 7] })).toBe(false);
  });

  it("rejects the old single-container field on its own", () => {
    const { containerNos: _omitted, ...rest } = valid;
    expect(isBooking({ ...rest, containerNo: "MSKU1" })).toBe(false);
  });
});

describe("tenant fixture", () => {
  it("loads, and has at least one booking with several containers", () => {
    const { bookings } = loadTenantFixture();
    expect(bookings.some((booking) => booking.containerNos.length > 1)).toBe(true);
  });
});
