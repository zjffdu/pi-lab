import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { ContainerEventRepository } from "../src/container-event-repository.js";
import { BookingNotFoundError, createGetBookingTool } from "../src/get-booking-tool.js";
import { ContainerEventsNotFoundError, createGetContainerEventsTool } from "../src/get-container-events-tool.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";

// `execute(args, api, context)` is only handed a real `api` when a harness runs the call as a
// durable task. These tools use none of it.
const api = {} as never;

describe("get_booking (pi-durable tool)", () => {
  const repository = BookingRepository.fromDefaultFixture();
  const tool = createGetBookingTool(repository);

  it("returns the BK1002 record including its customs hold — the lab's vulnerable early fact", async () => {
    const result = await tool.execute({ bookingNo: "BK1002" }, api, BACKGROUND_CONTEXT);

    expect(result.details).toEqual({ bookingNo: "BK1002" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(repository.findByBookingNo("BK1002")) }]);
    expect(JSON.stringify(result.content)).toContain("missing phytosanitary certificate");
  });

  it("returns every container of a multi-container booking", async () => {
    const result = await tool.execute({ bookingNo: "BK1001" }, api, BACKGROUND_CONTEXT);

    expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
      bookingNo: "BK1001",
      containerNos: ["MSKU1234567", "MSKU2345678"],
    });
  });

  it("throws a typed error for an unknown booking", async () => {
    await expect(tool.execute({ bookingNo: "BAD_ID" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new BookingNotFoundError("BAD_ID"),
    );
  });
});

describe("get_container_events (pi-durable tool)", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();
  const tool = createGetContainerEventsTool(repository);

  it("returns the container's events as structured evidence", async () => {
    const result = await tool.execute({ containerNo: "MSKU7654321" }, api, BACKGROUND_CONTEXT);

    expect(result.details).toEqual({ containerNo: "MSKU7654321", eventCount: 3 });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(repository.findByContainerNo("MSKU7654321")) },
    ]);
  });

  it("returns the events of a booking's second container separately from its first", async () => {
    const second = await tool.execute({ containerNo: "MSKU2345678" }, api, BACKGROUND_CONTEXT);
    const first = await tool.execute({ containerNo: "MSKU1234567" }, api, BACKGROUND_CONTEXT);

    expect(second.details).toEqual({ containerNo: "MSKU2345678", eventCount: 3 });
    expect(JSON.stringify(second.content)).not.toContain("MSKU1234567");
    expect(JSON.stringify(first.content)).not.toContain("MSKU2345678");
  });

  it("throws a typed error for an unknown container", async () => {
    await expect(tool.execute({ containerNo: "NOSUCH" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new ContainerEventsNotFoundError("NOSUCH"),
    );
  });
});
