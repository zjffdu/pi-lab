import type { PrincipalDirectory } from "./directory.js";
import type { SourceDocument } from "./document-repository.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * The read decision for one document: same tenant, and either a role the ACL lists or the subject
 * named in it. Roles are looked up in the server-side directory each time, so a revoked role or an
 * edited ACL takes effect on the next decision — nothing here is cached.
 */
export class AclService {
  public constructor(private readonly directory: PrincipalDirectory) {}

  public canRead(context: SecurityContext, doc: SourceDocument): boolean {
    assertSecurityContext(context);
    if (doc.tenantId !== context.tenantId) return false;
    if (doc.acl.subjects.includes(context.subject)) return true;
    return doc.acl.roles.some((role) => this.directory.hasRole(context.tenantId, context.subject, role));
  }
}
