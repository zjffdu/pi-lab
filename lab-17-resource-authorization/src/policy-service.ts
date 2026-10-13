import type { AuditChannel, AuditLog } from "./audit-log.js";
import type { BookingReader, ResourceView } from "./booking-store.js";
import type { PermissionDirectory } from "./directory.js";
import { decide, POLICY_SHA256, POLICY_VERSION, type Action, type Decision } from "./policy.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface AuthorizeRequest {
  action: Action;
  bookingNo: string;
  requestedStatus?: string;
  channel: Exclude<AuditChannel, "capability">;
  toolCallId?: string;
}

export interface AuthorizeResult {
  decision: Decision;
  /** The resource as the decision saw it; present only when the decision allowed the action. */
  resource: ResourceView | undefined;
}

/**
 * Gathers the *current* inputs for one decision — roles from the directory, the resource from
 * the store — runs the pure policy, and records the outcome before returning it. Nothing here is
 * cached across calls: a role revoked a millisecond ago is gone on the next call.
 *
 * The principal comes only from the `SecurityContext`; `AuthorizeRequest` has no field for a
 * subject, tenant, or role, so no caller (and therefore no model-supplied tool argument) can
 * substitute one.
 */
export class PolicyDecisionService {
  public constructor(
    private readonly directory: PermissionDirectory,
    private readonly reader: BookingReader,
    private readonly audit: AuditLog,
  ) {}

  public async authorize(context: SecurityContext, request: AuthorizeRequest): Promise<AuthorizeResult> {
    assertSecurityContext(context);
    const roles = this.directory.rolesFor(context.tenantId, context.subject);
    const resource = this.reader.describe(context, request.bookingNo);
    const decision = decide({
      principal: { tenantId: context.tenantId, subject: context.subject },
      roles,
      action: request.action,
      resource,
      requestedStatus: request.requestedStatus,
    });

    await this.audit.record({
      kind: "decision",
      at: new Date().toISOString(),
      requestId: context.requestId,
      actor: context.subject,
      tenantId: context.tenantId,
      roles,
      channel: request.channel,
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
      action: request.action,
      resource: { bookingNo: request.bookingNo },
      ...(request.requestedStatus === undefined ? {} : { requestedStatus: request.requestedStatus }),
      decision: decision.allowed ? "allow" : "deny",
      ...(decision.allowed ? { matchedRole: decision.matchedRole } : { reason: decision.reason }),
      policyVersion: POLICY_VERSION,
      policySha256: POLICY_SHA256,
    });

    return { decision, resource: decision.allowed ? resource : undefined };
  }
}
