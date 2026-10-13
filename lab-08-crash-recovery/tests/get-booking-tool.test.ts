import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { BookingNotFoundError, createGetBookingTool } from "../src/get-booking-tool.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";

// `execute(args, api, context)` is only handed a real `api` (streamed output, diagnostics,
// document reads) when a harness runs the call as a durable task. This tool uses none of it.
const api = {} as never;

describe("get_booking (pi-durable tool)", () => {
  const repository = BookingRepository.fromDefaultFixture();
  const tool = createGetBookingTool(repository);

  it("is registered under the name the model calls", () => {
    expect(tool.name).toBe("get_booking");
  });

  it("returns structured fixture evidence", async () => {
    const result = await tool.execute({ bookingNo: "BK1001" }, api, BACKGROUND_CONTEXT);

    expect(result.details).toEqual({ bookingNo: "BK1001" });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(repository.findByBookingNo("BK1001")) },
    ]);
  });

  it("throws a typed error for an unknown booking", async () => {
    await expect(tool.execute({ bookingNo: "BAD_ID" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new BookingNotFoundError("BAD_ID"),
    );
  });
});
