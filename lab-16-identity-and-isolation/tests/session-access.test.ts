import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintSecurityContextForTest } from "../src/security-context.js";
import { SessionAccessService, SessionNotFoundError } from "../src/session-access.js";
import { SessionRegistry } from "../src/session-registry.js";
import { BACKGROUND_CONTEXT, sessionDirectory } from "../src/session-store.js";

const ctx = (tenantId: string, subject: string) => mintSecurityContextForTest({ tenantId, subject, requestId: "r" });
const alice = ctx("tenant-a", "alice");
const bob = ctx("tenant-a", "bob");
const carol = ctx("tenant-b", "carol");
const runtime = BACKGROUND_CONTEXT;

describe("session access", () => {
  let dir: string;
  let sessionsRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-16-session-access-"));
    sessionsRoot = join(dir, "sessions");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  it("creates a personal session for the caller and lets only that caller reopen it", async () => {
    const service = new SessionAccessService(new SessionRegistry(), sessionsRoot);
    const created = await service.open(alice, undefined, runtime);
    expect(created.created).toBe(true);
    await created.storage.close(runtime);

    const reopened = await service.open(alice, created.sessionId, runtime);
    expect(reopened.created).toBe(false);
    expect(reopened.sessionId).toBe(created.sessionId);
    await reopened.storage.close(runtime);
  });

  it("denies another owner in the same tenant, another tenant, and an unknown ID with the same error", async () => {
    const service = new SessionAccessService(new SessionRegistry(), sessionsRoot);
    const created = await service.open(alice, undefined, runtime);
    await created.storage.close(runtime);

    const outcomes = await Promise.allSettled([
      service.open(bob, created.sessionId, runtime),
      service.open(carol, created.sessionId, runtime),
      service.open(alice, "00000000-0000-0000-0000-000000000000", runtime),
    ]);
    const messages = outcomes.map((outcome) => {
      expect(outcome.status).toBe("rejected");
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(SessionNotFoundError);
      return (reason as Error).message;
    });
    expect(new Set(messages).size).toBe(1);
  });

  it("creates no directory for a denied request", async () => {
    const service = new SessionAccessService(new SessionRegistry(), sessionsRoot);
    const created = await service.open(alice, undefined, runtime);
    await created.storage.close(runtime);
    const before = await readdir(sessionsRoot, { recursive: true });

    await expect(service.open(carol, created.sessionId, runtime)).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(service.open(bob, created.sessionId, runtime)).rejects.toBeInstanceOf(SessionNotFoundError);

    expect(await readdir(sessionsRoot, { recursive: true })).toEqual(before);
    expect(await exists(join(sessionsRoot, "tenant-b"))).toBe(false);
  });

  it("groups session storage by tenant on disk", async () => {
    const service = new SessionAccessService(new SessionRegistry(), sessionsRoot);
    const a = await service.open(alice, undefined, runtime);
    const c = await service.open(carol, undefined, runtime);
    await a.storage.close(runtime);
    await c.storage.close(runtime);

    expect(await readdir(join(sessionsRoot, "tenant-a"))).toEqual([a.sessionId]);
    expect(await readdir(join(sessionsRoot, "tenant-b"))).toEqual([c.sessionId]);
  });

  it("remembers ownership across a registry reload from disk", () => {
    const path = join(dir, "registry.jsonl");
    const record = new SessionRegistry(path).create(alice);

    const reloaded = new SessionRegistry(path);
    expect(reloaded.find(alice, record.sessionId)).toMatchObject({ tenantId: "tenant-a", ownerSubject: "alice" });
    expect(reloaded.find(bob, record.sessionId)).toBeUndefined();
    expect(reloaded.find(carol, record.sessionId)).toBeUndefined();
  });
});

describe("sessionDirectory", () => {
  it("nests the session under its tenant", () => {
    expect(sessionDirectory("/root", "tenant-a", "s1")).toBe("/root/tenant-a/s1");
  });

  it("encodes separators so an id cannot add a path level", () => {
    expect(sessionDirectory("/root", "tenant-a", "../x")).toBe("/root/tenant-a/..%2Fx");
    expect(sessionDirectory("/root", "a/b", "s1")).toBe("/root/a%2Fb/s1");
  });

  it("refuses an empty, dot, or dot-dot segment — encodeURIComponent leaves those alone", () => {
    for (const bad of ["", ".", ".."]) {
      expect(() => sessionDirectory("/root", bad, "s1")).toThrow(/not usable/);
      expect(() => sessionDirectory("/root", "tenant-a", bad)).toThrow(/not usable/);
    }
  });
});
