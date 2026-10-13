import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit-log.js";
import { resolveCapabilities } from "../src/capability-resolver.js";
import { PermissionDirectory } from "../src/directory.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

const ctx = (subject: string) => mintSecurityContextForTest({ tenantId: "tenant-a", subject, requestId: "r1" });

function setup() {
  const lines: string[] = [];
  const audit = new AuditLog((line) => void lines.push(line));
  const directory = new PermissionDirectory([
    { tenantId: "tenant-a", subject: "alice", roles: ["operator"] },
    { tenantId: "tenant-a", subject: "dave", roles: ["approver"] },
    { tenantId: "tenant-a", subject: "erin", roles: ["viewer"] },
    { tenantId: "tenant-a", subject: "nobody", roles: [] },
  ]);
  return { audit, directory, lines };
}

describe("resolveCapabilities", () => {
  it.each([
    ["alice", ["get_booking", "update_booking_status"]],
    ["dave", ["get_booking"]],
    ["erin", ["get_booking"]],
    ["nobody", []],
    ["unknown-person", []],
  ])("%s is offered %j", async (subject, expected) => {
    const { audit, directory } = setup();
    expect((await resolveCapabilities(ctx(subject), directory, audit)).offeredToolNames).toEqual(expected);
  });

  it("reads the directory on every call, so a revocation applies to the next operation", async () => {
    const { audit, directory } = setup();
    expect((await resolveCapabilities(ctx("alice"), directory, audit)).offeredToolNames).toContain("update_booking_status");
    directory.revoke("tenant-a", "alice", "operator");
    expect((await resolveCapabilities(ctx("alice"), directory, audit)).offeredToolNames).toEqual([]);
    directory.grant("tenant-a", "alice", "viewer");
    expect((await resolveCapabilities(ctx("alice"), directory, audit)).offeredToolNames).toEqual(["get_booking"]);
  });

  it("audits the resolved tool list with actor, tenant, roles, and policy version", async () => {
    const { audit, directory, lines } = setup();
    await resolveCapabilities(ctx("erin"), directory, audit);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      kind: "capabilities",
      actor: "erin",
      tenantId: "tenant-a",
      roles: ["viewer"],
      offeredTools: ["get_booking"],
      decision: "allow",
      policyVersion: "2026-09-19.1",
    });
  });

  it("refuses an object that is not a server-created SecurityContext", async () => {
    const { audit, directory } = setup();
    const forged = { tenantId: "tenant-a", subject: "alice", authSource: "local-test-token", requestId: "x" };
    await expect(resolveCapabilities(forged as never, directory, audit)).rejects.toThrow(/SecurityContext/);
  });
});
