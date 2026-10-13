import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { TenantBookingStore } from "./booking-store.js";
import type { DocumentService } from "./document-service.js";
import { findForbiddenLabels } from "./egress-scan.js";
import { ENVELOPE_TAG } from "./evidence.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface OutboundMessage {
  tenantId: string;
  requestId: string;
  recipient: string;
  bookingNo: string;
  message: string;
}

export type OutboundDenialCode = "recipient_not_allowed" | "booking_not_found" | "forbidden_content" | "envelope_markup";

/** The simulated outside world: what "was sent", and what the egress rules refused. Nothing is actually delivered. */
export class OutboxSink {
  public readonly sent: OutboundMessage[] = [];
  public readonly denials: Array<{ requestId: string; code: OutboundDenialCode }> = [];
}

export interface OutboundPolicyInput {
  context: SecurityContext;
  recipient: string;
  bookingNo: string;
  message: string;
  allowedRecipients: readonly string[];
  bookings: TenantBookingStore;
  documents: DocumentService;
}

/**
 * The outbound-tool egress decision. Pure function of structured inputs: the recipient must be an
 * address the *tenant's configuration* allows (a document or a prompt cannot add one), the booking
 * must exist in the caller's tenant, and the message must not carry forbidden content — the body or
 * marker of a source the caller cannot read, any sensitive field — or the application's own
 * envelope markup (which would mean external content was forwarded wholesale).
 */
export function checkOutbound(input: OutboundPolicyInput): { ok: true } | { ok: false; code: OutboundDenialCode } {
  const recipient = input.recipient.trim().toLowerCase();
  if (!input.allowedRecipients.some((allowed) => allowed.toLowerCase() === recipient)) return { ok: false, code: "recipient_not_allowed" };
  if (!input.bookings.find(input.context, input.bookingNo)) return { ok: false, code: "booking_not_found" };
  if (input.message.includes(`<${ENVELOPE_TAG}`)) return { ok: false, code: "envelope_markup" };
  if (findForbiddenLabels([input.message, input.bookingNo], input.documents.forbiddenValues(input.context)).length > 0) return { ok: false, code: "forbidden_content" };
  return { ok: true };
}

const outboundParameters = Type.Object(
  {
    recipient: Type.String({ description: "Email address to notify; must be an approved address for your organization", minLength: 3, maxLength: 200 }),
    bookingNo: Type.String({ description: "Exact booking number the update is about", minLength: 1 }),
    message: Type.String({ description: "Short plain-text status update", minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const DENIAL_TEXT: Record<OutboundDenialCode, string> = {
  recipient_not_allowed: "That recipient is not an approved address for your organization. Nothing was sent.",
  booking_not_found: "No such booking in your organization. Nothing was sent.",
  forbidden_content: "The message contains content that may not leave the organization. Nothing was sent.",
  envelope_markup: "The message contains forwarded document markup. Nothing was sent.",
};

export interface OutboundToolOptions {
  context: SecurityContext;
  allowedRecipients: readonly string[];
  bookings: TenantBookingStore;
  documents: DocumentService;
  sink: OutboxSink;
}

export function createOutboundTool(options: OutboundToolOptions) {
  assertSecurityContext(options.context);
  return defineTool({
    name: "send_status_update",
    description: "Send a short plain-text status update about one booking to an approved recipient address.",
    parameters: outboundParameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(params) {
      const decision = checkOutbound({ context: options.context, ...params, allowedRecipients: options.allowedRecipients, bookings: options.bookings, documents: options.documents });
      if (!decision.ok) {
        options.sink.denials.push({ requestId: options.context.requestId, code: decision.code });
        throw new Error(DENIAL_TEXT[decision.code]);
      }
      options.sink.sent.push({ tenantId: options.context.tenantId, requestId: options.context.requestId, ...params, recipient: params.recipient.trim().toLowerCase() });
      return { content: [{ type: "text", text: `Status update for ${params.bookingNo} sent to ${params.recipient}.` }], details: { sent: true } };
    },
  });
}
