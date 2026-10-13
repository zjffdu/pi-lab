import type { PrincipalDirectory } from "./directory.js";
import type { SecurityContext } from "./security-context.js";
import { assertSecurityContext } from "./security-context.js";

/**
 * The deliberately small authorization Lab 18 needs. **Lab 17 (resource authorization) was
 * skipped**, so this is *not* Lab 17's policy matrix: it has no per-resource ownership, no
 * policy versioning, and no delegated credentials. It answers only what the approval flow must
 * ask at each step, from the roles the server-side directory holds *now*.
 */
export interface ActionParties {
  tenantId: string;
  requester: string;
}

export class Policy {
  public constructor(private readonly directory: PrincipalDirectory) {}

  /** Operators create proposals. */
  public mayPropose(context: SecurityContext): boolean {
    assertSecurityContext(context);
    return this.directory.hasRole(context.tenantId, context.subject, "operator");
  }

  /** The requester and any approver in the tenant may look at an action; nobody else. */
  public mayView(context: SecurityContext, action: ActionParties): boolean {
    assertSecurityContext(context);
    return context.tenantId === action.tenantId && (context.subject === action.requester || this.directory.hasRole(context.tenantId, context.subject, "approver"));
  }

  /** Approvers decide, but never on their own proposals (separation of duties). */
  public mayDecide(context: SecurityContext, action: ActionParties): "ok" | "not_approver" | "self_approval" {
    assertSecurityContext(context);
    if (!this.directory.hasRole(context.tenantId, context.subject, "approver")) return "not_approver";
    if (context.subject === action.requester) return "self_approval";
    return "ok";
  }

  /** Approvers see every action in their tenant; everyone else sees only their own. */
  public mayViewAll(context: SecurityContext): boolean {
    assertSecurityContext(context);
    return this.directory.hasRole(context.tenantId, context.subject, "approver");
  }

  public mayRevoke(context: SecurityContext): boolean {
    assertSecurityContext(context);
    return this.directory.hasRole(context.tenantId, context.subject, "approver");
  }

  /** The requester (while still an operator) or an approver may trigger the execution handoff. */
  public mayTriggerExecution(context: SecurityContext, action: ActionParties): boolean {
    assertSecurityContext(context);
    if (context.subject === action.requester) return this.directory.hasRole(context.tenantId, context.subject, "operator");
    return this.directory.hasRole(context.tenantId, context.subject, "approver");
  }

  /** Re-checked at execution: both parties must still hold the role their step relied on. */
  public requesterStillMayPropose(action: ActionParties): boolean {
    return this.directory.hasRole(action.tenantId, action.requester, "operator");
  }

  public approverStillMayApprove(tenantId: string, approver: string): boolean {
    return this.directory.hasRole(tenantId, approver, "approver");
  }
}
