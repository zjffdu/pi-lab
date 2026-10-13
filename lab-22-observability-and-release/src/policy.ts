import type { PrincipalDirectory } from "./directory.js";
import type { SecurityContext } from "./security-context.js";
import { assertSecurityContext } from "./security-context.js";

/**
 * The small authorization surface the pipeline's `policy` and `approval` stages need. This is
 * **not** a rebuild of Lab 17's resource authorization or Lab 18's approval state machine — it is
 * the minimum role check that lets Lab 22's synthetic pipeline produce the "deny", "pending
 * approval", and "self-approval blocked" outcomes its scenarios and invariants need. See README,
 * "What this lab does and does not build on".
 *
 * Every method re-reads the directory at call time — nothing here caches a role decision. That
 * is what lets the `revoked-permission-reuse` scenario prove that a stale cached identity cannot
 * exercise a permission the directory no longer grants.
 */
export interface ActionParties {
  tenantId: string;
  requester: string;
}

export class Policy {
  public constructor(private readonly directory: PrincipalDirectory) {}

  /** Anyone the directory knows about, in their own tenant, may read. */
  public mayRead(context: SecurityContext): boolean {
    assertSecurityContext(context);
    return this.directory.has(context.tenantId, context.subject);
  }

  public mayPropose(context: SecurityContext): boolean {
    assertSecurityContext(context);
    return this.directory.hasRole(context.tenantId, context.subject, "operator");
  }

  /** Approvers decide, but never on their own proposals (separation of duties). */
  public mayDecide(context: SecurityContext, action: ActionParties): "ok" | "not_approver" | "self_approval" {
    assertSecurityContext(context);
    if (!this.directory.hasRole(context.tenantId, context.subject, "approver")) return "not_approver";
    if (context.subject === action.requester) return "self_approval";
    return "ok";
  }

  /** Re-checked immediately before the tool/connector stages run, not only at proposal time. */
  public requesterStillMayPropose(action: ActionParties): boolean {
    return this.directory.hasRole(action.tenantId, action.requester, "operator");
  }

  public approverStillMayApprove(tenantId: string, approver: string): boolean {
    return this.directory.hasRole(tenantId, approver, "approver");
  }
}
