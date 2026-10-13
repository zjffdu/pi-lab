import { describe, expect, it } from "vitest";

import { BookingStore } from "../src/booking-store.js";
import { isBooking, loadDirectoryFixture } from "../src/directory.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

const valid = {
  tenantId: "tenant-a",
  bookingNo: "BK9",
  ownerSubject: "alice",
  containerNos: ["MSKU0000001", "MSKU0000002"],
  origin: "CNSHA",
  destination: "NLRTM",
  vessel: "TEST VESSEL",
  plannedDeparture: "2026-09-10",
  plannedArrival: "2026-10-15",
  status: "booked",
};

describe("a booking can carry several containers", () => {
  it("accepts one or several containers", () => {
    expect(isBooking(valid)).toBe(true);
    expect(isBooking({ ...valid, containerNos: ["MSKU0000001"] })).toBe(true);
  });

  it.each([
    ["an empty list", { containerNos: [] }],
    ["a non-string element", { containerNos: ["MSKU0000001", 42] }],
    ["an empty-string element", { containerNos: ["MSKU0000001", ""] }],
    ["a non-array value", { containerNos: "MSKU0000001" }],
  ])("rejects %s", (_label, override) => {
    expect(isBooking({ ...valid, ...override })).toBe(false);
  });

  it("rejects the old single-container shape", () => {
    const { containerNos: _removed, ...rest } = valid;
    expect(isBooking({ ...rest, containerNo: "MSKU0000001" })).toBe(false);
  });

  it("loads the default fixture with at least one multi-container booking, and no booking without containers", () => {
    const { bookings } = loadDirectoryFixture();
    expect(bookings.every((booking) => booking.containerNos.length >= 1)).toBe(true);
    expect(bookings.some((booking) => booking.containerNos.length > 1)).toBe(true);
  });

  it("gives both tenants a multi-container BK1001 whose containers do not overlap", () => {
    const { bookings } = loadDirectoryFixture();
    const a = bookings.find((booking) => booking.tenantId === "tenant-a" && booking.bookingNo === "BK1001");
    const b = bookings.find((booking) => booking.tenantId === "tenant-b" && booking.bookingNo === "BK1001");
    expect(a?.containerNos.length).toBeGreaterThan(1);
    expect(b?.containerNos.length).toBeGreaterThan(1);
    expect(a?.containerNos.filter((containerNo) => b?.containerNos.includes(containerNo))).toEqual([]);
  });
});

describe("BookingStore with containerNos", () => {
  const alice = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "r" });

  it("returns every container, and a copy: mutating a result does not change the store", () => {
    const store = new BookingStore([valid]);
    const first = store.find(alice, "BK9");
    expect(first?.containerNos).toEqual(["MSKU0000001", "MSKU0000002"]);
    first?.containerNos.push("INJECTED");
    expect(store.find(alice, "BK9")?.containerNos).toEqual(["MSKU0000001", "MSKU0000002"]);
    expect(store.downstreamFind("tenant-a", "BK9")?.containerNos).toEqual(["MSKU0000001", "MSKU0000002"]);
  });

  it("does not alias the rows it was constructed from", () => {
    const rows = [{ ...valid, containerNos: [...valid.containerNos] }];
    const store = new BookingStore(rows);
    rows[0]?.containerNos.push("LATER");
    expect(store.find(alice, "BK9")?.containerNos).toEqual(["MSKU0000001", "MSKU0000002"]);
  });

  it("uses every container and the vessel as the markers that identify a booking", () => {
    expect(new BookingStore([valid]).markersFor("tenant-a", "BK9")).toEqual(["MSKU0000001", "MSKU0000002", "TEST VESSEL"]);
    expect(new BookingStore([valid]).markersFor("tenant-a", "BK-missing")).toEqual([]);
  });

  it("keeps a status change on the booking as a whole, leaving its containers alone", () => {
    const store = new BookingStore([valid]);
    store.downstreamSetStatus("tenant-a", "BK9", "on_hold", "alice");
    expect(store.downstreamFind("tenant-a", "BK9")).toMatchObject({ status: "on_hold", containerNos: ["MSKU0000001", "MSKU0000002"] });
  });
});
