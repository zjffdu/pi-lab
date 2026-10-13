import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { ActionService } from "./action-service.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * Three model-supplied fields and nothing else. There is no tenant, requester, approver, state,
 * or version parameter, and `additionalProperties: false` rejects a model that invents one: the
 * requester is closed over from the server-created `SecurityContext`, the resource version is
 * read by the service, and no argument can make a proposal approved.
 */
const proposeParameters = Type.Object(
  {
    bookingNo: Type.String({ description: "Exact booking number, for example BK1001", minLength: 1 }),
    newStatus: Type.String({ description: "Target status: booked, in_transit, on_hold, delivered, or cancelled", minLength: 1 }),
    reason: Type.String({ description: "Why the change is needed, in one or two sentences", minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

/** A type alias, not an interface: tool `details` must be assignable to pi-durable's `JsonObject`. */
export type ProposalDetails = {
  actionId: string;
  state: string;
  digest: string;
};

export interface ProposeToolOptions {
  context: SecurityContext;
  actions: ActionService;
  sessionId: string;
  /** Receives every proposal created during the request, for the run result. */
  onProposal: (details: ProposalDetails) => void;
}

const DENIAL_TEXT: Record<string, string> = {
  forbidden: "You are not permitted to propose booking changes.",
  no_change: "The booking already has that status; nothing to propose.",
};

/**
 * Proposal only. The tool cannot approve, reject, or execute: those are application endpoints that
 * authenticate a human approver. It creates a *pending* proposal, so a run that calls it changes
 * no booking. Declared `replay: "unsafe"` — the Pi 1.1 default for an undeclared tool, written out:
 * a proposal is a persisted write, so after a crash the harness settles the call as interrupted
 * instead of rerunning it.
 */
export function createProposeTool(options: ProposeToolOptions) {
  assertSecurityContext(options.context);
  return defineTool({
    name: "propose_booking_status_change",
    description:
      "Propose changing one of your organization's bookings to a new status. The status belongs to the booking as a whole, whatever number of containers it carries. This only creates a PENDING proposal for a human approver; it does not change the booking, and you cannot approve it.",
    parameters: proposeParameters,
    executionMode: "sequential",
    replay: "unsafe",
    async execute(params) {
      const result = await options.actions.propose(options.context, { ...params, sessionId: options.sessionId });
      if (!result.ok) {
        throw new Error(result.code === "not_found" ? `No booking found for: ${params.bookingNo}` : (DENIAL_TEXT[result.code] ?? "The proposal was refused."));
      }
      const details: ProposalDetails = { actionId: result.value.id, state: result.value.state, digest: result.value.digest };
      options.onProposal(details);
      return {
        content: [
          {
            type: "text",
            text: `Proposal ${details.actionId} created for ${result.value.bookingNo}: status -> ${result.value.newStatus}. State: pending. It has NOT been applied and needs approval from an authorized approver.`,
          },
        ],
        details,
      };
    },
  });
}
