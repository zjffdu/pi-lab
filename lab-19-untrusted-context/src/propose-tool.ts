import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { ProposalLedger } from "./proposal-ledger.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

const proposeParameters = Type.Object(
  {
    bookingNo: Type.String({ description: "Exact booking number, for example BK1001", minLength: 1 }),
    newStatus: Type.Union(
      [Type.Literal("booked"), Type.Literal("in_transit"), Type.Literal("on_hold"), Type.Literal("delivered"), Type.Literal("cancelled")],
      { description: "Target status" },
    ),
    reason: Type.String({ description: "Why the change is needed, in one or two sentences", minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

/** A type alias, not an interface: tool `details` must be assignable to pi-durable's `JsonObject`. */
export type ProposalDetails = {
  proposalId: string;
  state: "pending";
};

/**
 * Proposal only, as in Lab 18: it records a *pending* proposal and cannot approve, reject, or
 * execute. There is no tenant, requester, approver, or state parameter; the requester comes from the
 * server-created `SecurityContext`.
 */
export function createProposeTool(options: {
  context: SecurityContext;
  ledger: ProposalLedger;
  onProposal: (details: ProposalDetails) => void;
}) {
  assertSecurityContext(options.context);
  return defineTool({
    name: "propose_booking_status_change",
    description:
      "Propose changing one of your organization's bookings to a new status. The status belongs to the booking as a whole, whatever number of containers it carries. This only creates a PENDING proposal for a human approver; it changes nothing and you cannot approve it.",
    parameters: proposeParameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(params) {
      const result = options.ledger.propose(options.context, params);
      if (result === "forbidden") throw new Error("You are not permitted to propose booking changes.");
      if (result === "not_found") throw new Error(`No booking found for: ${params.bookingNo}`);
      const details: ProposalDetails = { proposalId: result.id, state: "pending" };
      options.onProposal(details);
      return {
        content: [{ type: "text", text: `Proposal ${result.id} created for ${result.bookingNo}: status -> ${result.newStatus}. State: pending. It has NOT been applied and needs approval from an authorized approver.` }],
        details,
      };
    },
  });
}
