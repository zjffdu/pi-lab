import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";
import { BookingRepository } from "../src/booking-repository.js";
import { OutboxRepository } from "../src/outbox-repository.js";
import { BookingNotFoundError, createRequestBookingHoldTool } from "../src/request-booking-hold-tool.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";

const api = { taskId: 12, callId: "call-1" } as never;

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

describe("request_booking_hold (unsafe-replay pi-durable tool)", () => {
  const bookingRepository = BookingRepository.fromDefaultFixture();

  it('declares replay: "unsafe" explicitly, and only a test can override it', () => {
    expect(createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, { delayMs: 5 }).replay).toBe("unsafe");
    expect(createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, { delayMs: 5, replay: "safe" }).replay).toBe("safe");
  });

  it("orders dispatch -> outbox append -> effect_appended checkpoint, all before the post-effect delay resolves", async () => {
    const events: string[] = [];
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, {
      delayMs: 20,
      onDispatch: () => events.push("dispatch"),
      onEffectAppended: () => events.push("effect_appended"),
    });

    const promise = tool.execute({ bookingNo: "BK1001", reason: "customs review" }, api, BACKGROUND_CONTEXT);

    // Both the outbox append and the effect_appended checkpoint have already happened synchronously,
    // before the artificial post-effect delay's promise can have settled.
    expect(events).toEqual(["dispatch", "effect_appended"]);
    expect(outbox.readAll()).toEqual([
      {
        taskId: "12",
        callId: "call-1",
        bookingNo: "BK1001",
        reason: "customs review",
        holdId: "hold-task-12",
        at: expect.any(Number),
      },
    ]);
    expect(attemptLog.readAll()).toEqual([
      { tool: "request_booking_hold", callId: "call-1", taskId: "12", detail: "BK1001", at: expect.any(Number) },
    ]);

    const result = await promise;
    expect(result.details).toEqual({ bookingNo: "BK1001", holdId: "hold-task-12" });
  });

  it("never appends to the outbox for an unknown booking", async () => {
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, {
      delayMs: 5,
      onDispatch: () => {},
    });

    await expect(tool.execute({ bookingNo: "BAD_ID", reason: "x" }, api, BACKGROUND_CONTEXT)).rejects.toEqual(
      new BookingNotFoundError("BAD_ID"),
    );
    expect(outbox.readAll()).toEqual([]);
  });

  it("derives holdId from the task id, not a locally generated random value", async () => {
    const tool = createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, {
      delayMs: 5,
      onDispatch: () => {},
      onEffectAppended: () => {},
    });

    await tool.execute({ bookingNo: "BK1002", reason: "customs review" }, api, BACKGROUND_CONTEXT);

    expect(outbox.readAll()[0]?.holdId).toBe("hold-task-12");
  });
});
