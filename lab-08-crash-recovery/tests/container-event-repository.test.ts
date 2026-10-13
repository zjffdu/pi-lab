import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { ContainerEventRepository } from "../src/container-event-repository.js";

describe("ContainerEventRepository", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("returns events for a known container, oldest first", () => {
    const events = repository.findByContainerNo("MSKU1234567");
    expect(events.length).toBeGreaterThan(0);
    const timestamps = events.map((event) => event.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it("returns an empty array for an unknown container", () => {
    expect(repository.findByContainerNo("BAD_CONTAINER")).toEqual([]);
  });

  it("has events for every container of every booking, including both containers of BK1001", () => {
    const bookings = BookingRepository.fromDefaultFixture();
    const containerNos = ["BK1001", "BK1002"].flatMap((bookingNo) => bookings.findByBookingNo(bookingNo)?.containerNos ?? []);

    expect(containerNos).toEqual(["MSKU1234567", "MSKU2345678", "MSKU7654321"]);
    for (const containerNo of containerNos) {
      expect(repository.findByContainerNo(containerNo).length, containerNo).toBeGreaterThan(0);
    }
  });
});
