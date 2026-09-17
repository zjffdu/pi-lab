import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { BookingNotFoundError, createGetBookingTool } from "../src/get-booking-tool.js";

describe("get_booking", () => {
  const repository = BookingRepository.fromDefaultFixture();
  const tool = createGetBookingTool(repository);

  it("returns structured fixture evidence", async () => {
    const result = await tool.execute(
      "call-1",
      { bookingNo: "BK1001" },
      new AbortController().signal,
    );

    expect(result.details).toEqual({ bookingNo: "BK1001" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(repository.findByBookingNo("BK1001")),
      },
    ]);
  });

  it("throws a typed error for an unknown booking, so Pi turns it into exactly one tool-error message", async () => {
    await expect(
      tool.execute("call-2", { bookingNo: "BAD_ID" }, new AbortController().signal),
    ).rejects.toEqual(new BookingNotFoundError("BAD_ID"));
  });
});
