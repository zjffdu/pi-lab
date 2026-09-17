import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";
import { BookingRepository } from "../src/booking-repository.js";
import { OutboxRepository } from "../src/outbox-repository.js";
import { BookingNotFoundError, createRequestBookingHoldTool } from "../src/request-booking-hold-tool.js";

const onUpdate = vi.fn();
const toolContext = undefined;
const invocation = {
  invocationId: "invocation-1",
  operationId: "operation-1",
  turnId: "turn-1",
  getMemo: vi.fn(),
  setMemo: vi.fn(),
};
const context = { abortSignal: undefined } as never;

let dir: string;
let attemptLog: AttemptLog;
let outbox: OutboxRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-09-hold-tool-"));
  attemptLog = new AttemptLog(join(dir, "attempts.jsonl"));
  outbox = new OutboxRepository(join(dir, "outbox.jsonl"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("request_booking_hold (never-replay harness tool)", () => {
  const bookingRepository = BookingRepository.fromDefaultFixture();

  it("declares replay: \"never\"", () => {
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, { delayMs: 5 });
    expect(tool.replay).toBe("never");
  });

  it("orders dispatch -> outbox append -> effect_appended checkpoint, all before the post-effect delay resolves", async () => {
    const events: string[] = [];
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, {
      delayMs: 20,
      onDispatch: () => events.push("dispatch"),
      onEffectAppended: () => events.push("effect_appended"),
    });

    const promise = tool.execute(
      "call-1",
      { bookingNo: "BK1001", reason: "customs review" },
      onUpdate,
      toolContext,
      invocation,
      context,
    );

    // Both the outbox append and the effect_appended checkpoint have already happened
    // synchronously, before the artificial post-effect delay's promise can have settled.
    expect(events).toEqual(["dispatch", "effect_appended"]);
    expect(outbox.readAll()).toEqual([
      { invocationId: "invocation-1", bookingNo: "BK1001", reason: "customs review", holdId: "hold-invocation-1", at: expect.any(Number) },
    ]);
    expect(attemptLog.readAll()).toEqual([
      { tool: "request_booking_hold", toolCallId: "call-1", invocationId: "invocation-1", detail: "BK1001", at: expect.any(Number) },
    ]);

    const result = await promise;
    expect(result.details).toEqual({ bookingNo: "BK1001", holdId: "hold-invocation-1" });
  });

  it("never appends to the outbox for an unknown booking", async () => {
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, { delayMs: 5 });

    await expect(
      tool.execute("call-2", { bookingNo: "BAD_ID", reason: "x" }, onUpdate, toolContext, invocation, context),
    ).rejects.toEqual(new BookingNotFoundError("BAD_ID"));
    expect(outbox.readAll()).toEqual([]);
  });

  it("derives holdId from invocationId, not a locally generated random value", async () => {
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, { delayMs: 5 });

    await tool.execute("call-1", { bookingNo: "BK1001", reason: "customs review" }, onUpdate, toolContext, invocation, context);

    expect(outbox.readAll()[0]?.holdId).toBe(`hold-${invocation.invocationId}`);
  });
});
