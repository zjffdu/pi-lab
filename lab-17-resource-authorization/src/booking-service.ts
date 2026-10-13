import type { Booking, BookingReader } from "./booking-store.js";
import type { BookingConnector, StatusChangeResult } from "./booking-connector.js";
import type { DenyReason } from "./policy.js";
import type { PolicyDecisionService } from "./policy-service.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/** A refusal that is safe to show the model and the user. `reason` is for tests and the audit log. */
export class AuthorizationDeniedError extends Error {
  public constructor(
    public readonly reason: DenyReason,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationDeniedError";
  }
}

/** The decision could not be made or recorded, so nothing was done. Detail stays on `cause`. */
export class AuthorizationUnavailableError extends Error {
  public constructor(cause: unknown) {
    super("The request could not be authorized, so nothing was done.", { cause });
    this.name = "AuthorizationUnavailableError";
  }
}

export interface CallMeta {
  channel: "application" | "tool";
  toolCallId?: string;
}

export interface BookingServiceOptions {
  policy: PolicyDecisionService;
  reader: BookingReader;
  connector: BookingConnector;
  /**
   * Demo/test-only seam. Runs after an "allow" has been decided and audited and before the
   * effect; the crash-recovery test parks here so a run can be killed with a tool call in
   * flight. Never set outside `scripts/` and `tests/`.
   */
  afterAuthorization?: (info: { action: string; bookingNo: string }) => Promise<void>;
}

function messageFor(reason: DenyReason, bookingNo: string, verb: "read" | "change"): string {
  switch (reason) {
    case "no_role_grant":
      return verb === "read" ? "You are not permitted to read bookings." : "You are not permitted to change booking status.";
    case "resource_not_visible":
      // Same text for "missing", "another tenant", and "not yours": a denial must not confirm existence.
      return `No booking found for: ${bookingNo}`;
    case "state_not_editable":
      return `Booking ${bookingNo} cannot be changed in its current status.`;
    case "transition_not_allowed":
      return `That status change is not allowed for booking ${bookingNo}.`;
  }
}

/**
 * The application boundary for bookings, and the only path from anything the model can reach to a
 * booking's content or to a write. Every call — from a tool on a fresh run, from a tool
 * re-executed by `resume()`, or from a direct application call with no model at all — is
 * authorized here against the current roles and the current resource, and audited, before the
 * effect. The tools are thin wrappers; they hold no policy of their own.
 */
export class BookingService {
  public constructor(private readonly options: BookingServiceOptions) {}

  public async read(context: SecurityContext, bookingNo: string, meta: CallMeta): Promise<Booking> {
    assertSecurityContext(context);
    await this.authorize(context, "booking:read", bookingNo, undefined, meta, "read");
    const booking = this.options.reader.find(context, bookingNo);
    if (!booking) throw new AuthorizationDeniedError("resource_not_visible", messageFor("resource_not_visible", bookingNo, "read"));
    return booking;
  }

  public async updateStatus(
    context: SecurityContext,
    request: { bookingNo: string; newStatus: string },
    meta: CallMeta,
  ): Promise<StatusChangeResult> {
    assertSecurityContext(context);
    const resource = await this.authorize(context, "booking:update_status", request.bookingNo, request.newStatus, meta, "change");
    return this.options.connector.updateStatus(context, {
      bookingNo: request.bookingNo,
      newStatus: request.newStatus,
      expectedStatus: resource.status,
    });
  }

  private async authorize(
    context: SecurityContext,
    action: "booking:read" | "booking:update_status",
    bookingNo: string,
    requestedStatus: string | undefined,
    meta: CallMeta,
    verb: "read" | "change",
  ) {
    let result;
    try {
      result = await this.options.policy.authorize(context, {
        action,
        bookingNo,
        requestedStatus,
        channel: meta.channel,
        toolCallId: meta.toolCallId,
      });
    } catch (error) {
      throw new AuthorizationUnavailableError(error);
    }
    if (!result.decision.allowed) {
      throw new AuthorizationDeniedError(result.decision.reason, messageFor(result.decision.reason, bookingNo, verb));
    }
    await this.options.afterAuthorization?.({ action, bookingNo });
    if (!result.resource) throw new AuthorizationDeniedError("resource_not_visible", messageFor("resource_not_visible", bookingNo, verb));
    return result.resource;
  }
}
