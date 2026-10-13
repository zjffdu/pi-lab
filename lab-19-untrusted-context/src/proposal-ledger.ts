import { randomUUID } from "node:crypto";

import type { TenantBookingStore } from "./booking-store.js";
import type { PrincipalDirectory } from "./directory.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface Proposal {
  id: string;
  tenantId: string;
  requester: string;
  bookingNo: string;
  newStatus: string;
  reason: string;
  state: "pending";
}

export interface Approval {
  proposalId: string;
  approver: string;
}

/**
 * A deliberately small in-memory stand-in for Lab 18's durable approval records — this lab needs
 * only something an experiment can snapshot to show that document text changed nothing. It has
 * **none** of Lab 18's guarantees (no digest binding, no expiry, no one-time consumption, no
 * database). The one property it keeps: approvals have a single writer, `recordApproval`, which
 * requires a server-created approver context. No tool and no HTTP route in this lab calls it.
 */
export class ProposalLedger {
  private readonly proposalList: Proposal[] = [];
  private readonly approvalList: Approval[] = [];

  public constructor(
    private readonly bookings: TenantBookingStore,
    private readonly directory: PrincipalDirectory,
  ) {}

  public get proposals(): readonly Proposal[] {
    return this.proposalList.map((proposal) => ({ ...proposal }));
  }

  public get approvals(): readonly Approval[] {
    return this.approvalList.map((approval) => ({ ...approval }));
  }

  public snapshot(): string {
    return JSON.stringify({ proposals: this.proposalList, approvals: this.approvalList });
  }

  public propose(context: SecurityContext, input: { bookingNo: string; newStatus: string; reason: string }): Proposal | "not_found" | "forbidden" {
    assertSecurityContext(context);
    if (!this.directory.hasRole(context.tenantId, context.subject, "operator")) return "forbidden";
    if (!this.bookings.find(context, input.bookingNo)) return "not_found";
    const proposal: Proposal = { id: randomUUID(), tenantId: context.tenantId, requester: context.subject, ...input, state: "pending" };
    this.proposalList.push(proposal);
    return { ...proposal };
  }

  /** Test/demo entry point standing in for Lab 18's authenticated approval endpoint. */
  public recordApproval(approver: SecurityContext, proposalId: string): "ok" | "not_found" | "forbidden" {
    assertSecurityContext(approver);
    const proposal = this.proposalList.find((candidate) => candidate.id === proposalId && candidate.tenantId === approver.tenantId);
    if (!proposal) return "not_found";
    if (!this.directory.hasRole(approver.tenantId, approver.subject, "approver") || proposal.requester === approver.subject) return "forbidden";
    this.approvalList.push({ proposalId, approver: approver.subject });
    return "ok";
  }
}
