import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { BookingNotFoundError, createGetBookingTool } from "../src/get-booking-tool.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { createUpdateBookingStatusTool, updateBookingStatusParameters } from "../src/update-booking-status-tool.js";
import { BOOKING_STATUSES } from "../src/booking-repository.js";

// `execute(args, api, context)` is only handed a real `api` when a harness runs the call as a durable task.
// These tools use none of it.
const api = {} as never;

describe("get_booking (pi-durable tool)", () => {
  const tool = createGetBookingTool(BookingRepository.fromDefaultFixture());

  it("is read-only and declares replay safe", () => {
    expect(tool.replay).toBe("safe");
  });

  it("returns every container of a multi-container booking, and its status", async () => {
    const result = await tool.execute({ bookingNo: "BK1001" }, api, BACKGROUND_CONTEXT);
    expect(result.details).toEqual({ bookingNo: "BK1001" });
    expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
      bookingNo: "BK1001",
      containerNos: ["MSKU1234567", "MSKU2345678"],
      status: "booked",
    });
  });

  it("throws a typed error for an unknown booking", async () => {
    await expect(tool.execute({ bookingNo: "BAD_ID" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(new BookingNotFoundError("BAD_ID"));
  });
});

describe("update_booking_status (pi-durable tool)", () => {
  it("accepts exactly the statuses the repository knows", () => {
    const offered = (updateBookingStatusParameters.properties.newStatus.anyOf as { const: string }[]).map((member) => member.const);
    expect(offered).toEqual([...BOOKING_STATUSES]);
  });

  it("is state-changing and declares replay unsafe", () => {
    expect(createUpdateBookingStatusTool(BookingRepository.fromDefaultFixture()).replay).toBe("unsafe");
  });

  it("mutates the repository and reports previous and new status", async () => {
    const repository = BookingRepository.fromDefaultFixture();
    const result = await createUpdateBookingStatusTool(repository).execute(
      { bookingNo: "BK1002", newStatus: "in_transit" },
      api,
      BACKGROUND_CONTEXT,
    );
    expect(result.details).toEqual({ bookingNo: "BK1002", previousStatus: "booked", newStatus: "in_transit" });
    expect(repository.findByBookingNo("BK1002")?.status).toBe("in_transit");
  });

  it("throws a typed error for an unknown booking and changes nothing", async () => {
    const repository = BookingRepository.fromDefaultFixture();
    await expect(
      createUpdateBookingStatusTool(repository).execute({ bookingNo: "BAD_ID", newStatus: "in_transit" }, api, BACKGROUND_CONTEXT),
    ).rejects.toEqual(new BookingNotFoundError("BAD_ID"));
    expect(repository.all().map((booking) => booking.status)).toEqual(["booked", "booked", "delivered"]);
  });
});
