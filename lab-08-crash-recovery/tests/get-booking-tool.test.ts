import { describe, expect, it, vi } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { BookingNotFoundError, createGetBookingTool } from "../src/get-booking-tool.js";

// AgentHarnessTool.execute's real parameters (onUpdate, toolContext, invocation, context)
// are only meaningful once a harness is driving a live operation. This tool never touches
// any of them, so the tests pass harmless stand-ins.
const onUpdate = vi.fn();
const toolContext = undefined;
const invocation = {
  invocationId: "invocation-1",
  operationId: "operation-1",
  turnId: "turn-1",
  getMemo: vi.fn(),
  setMemo: vi.fn(),
};
const context = {} as never;

describe("get_booking (harness tool)", () => {
  const repository = BookingRepository.fromDefaultFixture();
  const tool = createGetBookingTool(repository);

  it("returns structured fixture evidence", async () => {
    const result = await tool.execute(
      "call-1",
      { bookingNo: "BK1001" },
      onUpdate,
      toolContext,
      invocation,
      context,
    );

    expect(result.details).toEqual({ bookingNo: "BK1001" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(repository.findByBookingNo("BK1001")),
      },
    ]);
  });

  it("throws a typed error for an unknown booking", async () => {
    await expect(
      tool.execute("call-2", { bookingNo: "BAD_ID" }, onUpdate, toolContext, invocation, context),
    ).rejects.toEqual(new BookingNotFoundError("BAD_ID"));
  });
});
