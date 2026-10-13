import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import { BOOKING_STATUSES, type BookingRepository } from "./booking-repository.js";

const updateBookingStatusParameters = Type.Object(
  {
    bookingNo: Type.String({
      description: "Exact booking number, for example BK1001",
      minLength: 1,
    }),
    newStatus: Type.Union(
      BOOKING_STATUSES.map((status) => Type.Literal(status)),
      { description: `One of: ${BOOKING_STATUSES.join(", ")}` },
    ),
  },
  { additionalProperties: false },
);

/** What one successful status change did, reported at the moment the mutation happened. */
export interface StatusChange {
  conversationId: number;
  /** The `pi.tool` task of this call: unique in the session, and the same when a recovered process reruns it. */
  taskId: number;
  toolCallId: string;
  bookingNo: string;
  /** Every container on the booking: a status change applies to the booking as a whole, so to all of them. */
  containerNos: readonly string[];
  previousStatus: string;
  newStatus: string;
}

export class BookingNotFoundError extends Error {
  public constructor(bookingNo: string) {
    super(`Booking not found: ${bookingNo}`);
    this.name = "BookingNotFoundError";
  }
}

/**
 * This lab's one local, state-changing candidate tool. A status belongs to the whole booking, however
 * many containers it carries.
 *
 * Being *offered* only decides whether the model can request it at all; it says nothing about whether
 * a given request should be allowed. That is `tool-policy.ts`'s job, enforced by the `beforeTool` hook
 * in `governance-hooks.ts`. `execute()` therefore performs the mutation unconditionally: by the time
 * it runs, `beforeTool` has already had its chance to block, so the tool does not re-implement policy.
 * Its structural constraints (which strings `newStatus` may even be) live in the TypeBox schema above,
 * which the harness validates *before* `beforeTool` runs; its business rules live in `tool-policy.ts`.
 *
 * `replay: "unsafe"` is the harness default for an undeclared tool, written out so the contrast with
 * `get_booking`'s `"safe"` is visible in the source. This lab never kills a process mid-call, so the
 * declaration only matters in one place: a `beforeTool` or `afterTool` failure's interaction with the
 * durable intent that is committed between them (see the README's Finding D).
 */
export function createUpdateBookingStatusTool(repository: BookingRepository, onChange?: (change: StatusChange) => void) {
  return defineTool({
    name: "update_booking_status",
    description:
      "Change one booking's status (the booking as a whole, not one container). State-changing and " +
      "subject to local policy: some changes are rejected no matter how they are requested.",
    parameters: updateBookingStatusParameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(args, api) {
      const booking = repository.findByBookingNo(args.bookingNo);
      if (!booking) {
        throw new BookingNotFoundError(args.bookingNo);
      }

      const previousStatus = booking.status;
      repository.updateStatus(args.bookingNo, args.newStatus);
      onChange?.({
        conversationId: api.conversationId,
        taskId: api.taskId,
        toolCallId: api.callId,
        bookingNo: args.bookingNo,
        containerNos: [...booking.containerNos],
        previousStatus,
        newStatus: args.newStatus,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ bookingNo: args.bookingNo, previousStatus, newStatus: args.newStatus }),
          },
        ],
        details: { bookingNo: args.bookingNo, previousStatus, newStatus: args.newStatus },
      };
    },
  });
}
