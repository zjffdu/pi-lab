import { describe, expect, it } from "vitest";

import { formatCheckpoint, parseCheckpoint, parseCheckpointName } from "../src/checkpoint.js";

describe("checkpoint format", () => {
  it("round-trips name and fields through format/parse", () => {
    const line = formatCheckpoint({
      name: "effect_appended",
      tool: "request_booking_hold",
      taskId: "12",
      callId: "call-1",
      bookingNo: "BK1001",
      holdId: "hold-abc",
    });

    expect(line).toBe("[Checkpoint] effect_appended tool=request_booking_hold taskId=12 callId=call-1 bookingNo=BK1001 holdId=hold-abc");
    expect(parseCheckpointName(line)).toBe("effect_appended");
    expect(parseCheckpoint(line)).toEqual({
      name: "effect_appended",
      fields: {
        tool: "request_booking_hold",
        taskId: "12",
        callId: "call-1",
        bookingNo: "BK1001",
        holdId: "hold-abc",
      },
    });
  });

  it("returns undefined for a line that is not a checkpoint", () => {
    expect(parseCheckpoint("[Assistant] hello")).toBeUndefined();
    expect(parseCheckpointName("[Assistant] hello")).toBeUndefined();
  });
});
