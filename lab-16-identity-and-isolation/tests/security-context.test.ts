import { describe, expect, it } from "vitest";

import { UntrustedSecurityContextError, assertSecurityContext, mintSecurityContextForTest } from "../src/security-context.js";

describe("SecurityContext", () => {
  it("accepts a server-minted context and freezes it", () => {
    const context = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "r1" });
    expect(() => assertSecurityContext(context)).not.toThrow();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { tenantId: string }).tenantId = "tenant-b";
    }).toThrow();
  });

  it("rejects a look-alike object literal, such as one assembled from tool arguments or a request body", () => {
    const lookAlike = { tenantId: "tenant-b", subject: "carol", authSource: "local-test-token", requestId: "r1" };
    expect(() => assertSecurityContext(lookAlike)).toThrow(UntrustedSecurityContextError);
  });

  it("rejects a spread copy of a genuine context", () => {
    const context = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "r1" });
    expect(() => assertSecurityContext({ ...context, tenantId: "tenant-b" })).toThrow(UntrustedSecurityContextError);
  });

  it("rejects null and non-objects", () => {
    for (const value of [null, undefined, "tenant-a", 42]) {
      expect(() => assertSecurityContext(value)).toThrow(UntrustedSecurityContextError);
    }
  });
});
