import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { AttemptLog } from "./attempt-log.js";
import type { BookingRepository } from "./booking-repository.js";
import { formatCheckpoint } from "./checkpoint.js";
import type { ToolDispatch } from "./get-container-events-safe-tool.js";
import type { OutboxRepository } from "./outbox-repository.js";

const requestBookingHoldParameters = Type.Object(
  {
    bookingNo: Type.String({
      description: "Exact booking number to place a hold on, for example BK1001",
      minLength: 1,
    }),
    reason: Type.String({
      description: "Short reason for the hold, for example 'customs review'",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`Booking not found: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

export interface RequestBookingHoldToolOptions {
  /** Defaults to `"unsafe"`, the declaration that matches this tool's behavior. Exists only so an
   * offline test can show what a *wrong* `"safe"` declaration does to a state-changing tool. */
  replay?: "safe" | "unsafe";
  /** Artificial "confirming with an external system" delay *after* the local effect is
   * already durable. The failure injection kills the process during this window, once the
   * outbox entry already exists but before the tool's result is committed. */
  delayMs: number;
  /** Fires the instant `execute()` starts, before the booking lookup or the outbox write. */
  onDispatch?: (dispatch: ToolDispatch & { bookingNo: string }) => void;
  /** Fires immediately after the outbox append: the moment this call's local business effect
   * becomes irreversible, and the checkpoint the failure injection actually kills at.
   * Everything after it (the delay, the return) is Pi's problem to recover, not the effect's. */
  onEffectAppended?: (effect: ToolDispatch & { bookingNo: string; holdId: string }) => void;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * State-changing and declared `replay: "unsafe"` (the default for an undeclared tool; this lab
 * sets it explicitly so the contrast with the safe tool is visible in the source, not just
 * inferred). Its only effect is a synchronous append to a lab-local outbox fixture: no real
 * notification, booking system, or API. When a process dies after that append but before Pi
 * commits this call's result, the recovering harness must not call `execute()` again: it
 * commits an `isError` `interrupted` result instead. The task id and call id on the outbox
 * record and the attempt log are what let a learner correlate "the effect that really
 * happened" back to "the one logical call Pi believes was interrupted", without inventing a
 * second one.
 */
export function createRequestBookingHoldTool(
  bookingRepository: BookingRepository,
  outbox: OutboxRepository,
  attemptLog: AttemptLog,
  options: RequestBookingHoldToolOptions,
) {
  const onDispatch =
    options.onDispatch ??
    (({ taskId, callId, bookingNo }) => {
      console.log(formatCheckpoint({ name: "tool_dispatched", tool: "request_booking_hold", taskId, callId, bookingNo }));
    });
  const onEffectAppended =
    options.onEffectAppended ??
    (({ taskId, callId, bookingNo, holdId }) => {
      console.log(
        formatCheckpoint({ name: "effect_appended", tool: "request_booking_hold", taskId, callId, bookingNo, holdId }),
      );
    });

  return defineTool({
    name: "request_booking_hold",
    description:
      "Place an operational hold request against one booking, with a reason. State-changing " +
      "and not safe to repeat: call this at most once per distinct hold request.",
    parameters: requestBookingHoldParameters,
    executionMode: "sequential",
    replay: options.replay ?? "unsafe",
    async execute(args, api, context) {
      const taskId = String(api.taskId);
      attemptLog.recordSync({
        tool: "request_booking_hold",
        callId: api.callId,
        taskId,
        detail: args.bookingNo,
        at: Date.now(),
      });
      onDispatch({ taskId, callId: api.callId, bookingNo: args.bookingNo });

      const booking = bookingRepository.findByBookingNo(args.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(args.bookingNo);
      }

      const holdId = `hold-task-${taskId}`;
      outbox.appendSync({
        taskId,
        callId: api.callId,
        bookingNo: args.bookingNo,
        reason: args.reason,
        holdId,
        at: Date.now(),
      });
      onEffectAppended({ taskId, callId: api.callId, bookingNo: args.bookingNo, holdId });

      await delay(options.delayMs, context.abortSignal);

      return {
        content: [{ type: "text", text: JSON.stringify({ holdId, bookingNo: args.bookingNo, status: "requested" }) }],
        details: { bookingNo: args.bookingNo, holdId },
      };
    },
  });
}
