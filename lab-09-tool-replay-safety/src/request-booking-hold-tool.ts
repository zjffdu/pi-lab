import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { AttemptLog } from "./attempt-log.js";
import type { BookingRepository } from "./booking-repository.js";
import { formatCheckpoint } from "./checkpoint.js";
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

interface RequestBookingHoldDetails {
  bookingNo: string;
  holdId: string;
}

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`Booking not found: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

export interface RequestBookingHoldToolOptions {
  /** Artificial "confirming with an external system" delay *after* the local effect is
   * already durable. The failure injection kills the process during this window, once the
   * outbox entry already exists but before the tool's result is committed. */
  delayMs: number;
  /** Fires the instant execute() starts, before the booking lookup or the outbox write. */
  onDispatch?: (toolCallId: string, bookingNo: string) => void;
  /** Fires immediately after the outbox append — the moment this call's local business
   * effect becomes irreversible, and the checkpoint the failure injection actually kills
   * at. Everything after this point (the delay, the return) is Pi's problem to recover,
   * not the effect's. */
  onEffectAppended?: (toolCallId: string, bookingNo: string, holdId: string) => void;
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
 * State-changing and declared `replay: "never"` (the harness default for an undeclared
 * tool — this lab sets it explicitly so the contrast with the safe tool is visible in the
 * source, not just inferred). Its only effect is a synchronous append to a lab-local
 * outbox fixture — no real notification, booking system, or API, per the roadmap's
 * exclusions. When a process dies after that append but before Pi commits this call's
 * result, `lane.resume()` must not call `execute()` again: it synthesizes an
 * `isError: true` result from the durable checkpoint instead, exactly as it does for any
 * other `"never"`-replay tool. The `invocationId` on the outbox record and the attempt log
 * is what lets a learner correlate "the effect that really happened" back to "the one
 * logical call the harness believes was interrupted," without ever inventing a second one.
 */
export function createRequestBookingHoldTool(
  bookingRepository: BookingRepository,
  outbox: OutboxRepository,
  attemptLog: AttemptLog,
  options: RequestBookingHoldToolOptions,
): AgentHarnessTool<undefined, typeof requestBookingHoldParameters, RequestBookingHoldDetails> {
  const onDispatch =
    options.onDispatch ??
    ((toolCallId: string, bookingNo: string) => {
      console.log(
        formatCheckpoint({ name: "tool_dispatched", toolCallId, tool: "request_booking_hold", bookingNo }),
      );
    });
  const onEffectAppended =
    options.onEffectAppended ??
    ((toolCallId: string, bookingNo: string, holdId: string) => {
      console.log(
        formatCheckpoint({ name: "effect_appended", toolCallId, tool: "request_booking_hold", bookingNo, holdId }),
      );
    });

  return {
    name: "request_booking_hold",
    label: "Request booking hold (never replay)",
    description:
      "Place an operational hold request against one booking, with a reason. State-changing " +
      "and not safe to repeat: call this at most once per distinct hold request.",
    parameters: requestBookingHoldParameters,
    executionMode: "sequential",
    replay: "never",
    async execute(toolCallId, params, _onUpdate, _toolContext, invocation, context) {
      attemptLog.recordSync({
        tool: "request_booking_hold",
        toolCallId,
        invocationId: invocation.invocationId,
        detail: params.bookingNo,
        at: Date.now(),
      });
      onDispatch(toolCallId, params.bookingNo);

      const booking = bookingRepository.findByBookingNo(params.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(params.bookingNo);
      }

      const holdId = `hold-${invocation.invocationId}`;
      outbox.appendSync({
        invocationId: invocation.invocationId,
        bookingNo: params.bookingNo,
        reason: params.reason,
        holdId,
        at: Date.now(),
      });
      onEffectAppended(toolCallId, params.bookingNo, holdId);

      await delay(options.delayMs, context.abortSignal);

      return {
        content: [{ type: "text", text: JSON.stringify({ holdId, bookingNo: params.bookingNo, status: "requested" }) }],
        details: { bookingNo: params.bookingNo, holdId },
      };
    },
  };
}
