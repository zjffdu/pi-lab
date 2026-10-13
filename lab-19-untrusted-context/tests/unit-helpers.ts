import { AclService } from "../src/acl.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { DocumentRepository } from "../src/document-repository.js";
import { DocumentService, RetrievalCache } from "../src/document-service.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";

export const ctx = (tenantId: string, subject: string): SecurityContext => mintSecurityContextForTest({ tenantId, subject, requestId: `req-${subject}` });

export function newDocuments(now: Date | (() => Date) = new Date("2026-09-20T00:00:00Z")) {
  const directory = new PrincipalDirectory(loadTenantFixture().principals);
  const repository = DocumentRepository.fromDefaultFixture();
  const cache = new RetrievalCache();
  const documents = new DocumentService({ repository, acl: new AclService(directory), cache, clock: typeof now === "function" ? now : () => now });
  return { directory, repository, cache, documents };
}
