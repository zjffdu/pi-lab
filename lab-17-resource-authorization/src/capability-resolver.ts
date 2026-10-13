import type { AuditLog } from "./audit-log.js";
import type { PermissionDirectory, Role } from "./directory.js";
import { POLICY_SHA256, POLICY_VERSION, ROLE_GRANTS, type Action } from "./policy.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export const READ_TOOL_NAME = "get_booking";
export const WRITE_TOOL_NAME = "update_booking_status";

const TOOL_FOR_ACTION: ReadonlyArray<{ tool: string; action: Action }> = [
  { tool: READ_TOOL_NAME, action: "booking:read" },
  { tool: WRITE_TOOL_NAME, action: "booking:update_status" },
];

export interface ResolvedCapabilities {
  roles: Role[];
  offeredToolNames: string[];
}

/**
 * Decides which tools the *model may even be offered* for this operation, from the caller's
 * roles today. This is a coarse structural gate: role-level only, it says nothing about any
 * particular booking. Resource-level authorization still happens at the effect boundary
 * (`booking-service.ts`), independently and unconditionally.
 *
 * The result must be applied to the conversation on every operation: a reopened conversation keeps
 * the tool offer it *stored* (`root({ agent })` is honored only when the root is created), so
 * yesterday's offer is not a grant.
 */
export async function resolveCapabilities(
  context: SecurityContext,
  directory: PermissionDirectory,
  audit: AuditLog,
): Promise<ResolvedCapabilities> {
  assertSecurityContext(context);
  const roles = directory.rolesFor(context.tenantId, context.subject);
  const offeredToolNames = TOOL_FOR_ACTION.filter(({ action }) => roles.some((role) => ROLE_GRANTS[role][action] !== undefined)).map(
    ({ tool }) => tool,
  );

  await audit.record({
    kind: "capabilities",
    at: new Date().toISOString(),
    requestId: context.requestId,
    actor: context.subject,
    tenantId: context.tenantId,
    roles,
    channel: "capability",
    offeredTools: offeredToolNames,
    decision: offeredToolNames.length > 0 ? "allow" : "deny",
    policyVersion: POLICY_VERSION,
    policySha256: POLICY_SHA256,
  });

  return { roles, offeredToolNames };
}
