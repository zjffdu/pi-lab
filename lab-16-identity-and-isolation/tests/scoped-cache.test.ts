import { describe, expect, it } from "vitest";

import { ScopedCache } from "../src/scoped-cache.js";

describe("ScopedCache", () => {
  it("keeps the same key separate across tenants", () => {
    const cache = new ScopedCache<string>();
    cache.set({ tenantId: "tenant-a" }, "BK1001", "alpha");
    expect(cache.get({ tenantId: "tenant-a" }, "BK1001")).toBe("alpha");
    expect(cache.get({ tenantId: "tenant-b" }, "BK1001")).toBeUndefined();
  });

  it("keeps owner-scoped entries separate from each other and from tenant-scoped ones", () => {
    const cache = new ScopedCache<string>();
    cache.set({ tenantId: "tenant-a", subject: "alice" }, "draft", "alice's");
    expect(cache.get({ tenantId: "tenant-a", subject: "alice" }, "draft")).toBe("alice's");
    expect(cache.get({ tenantId: "tenant-a", subject: "bob" }, "draft")).toBeUndefined();
    expect(cache.get({ tenantId: "tenant-a" }, "draft")).toBeUndefined();
  });

  it("does not collide when delimiter characters shift between tenant and key", () => {
    const cache = new ScopedCache<string>();
    cache.set({ tenantId: "a:b" }, "c", "first");
    cache.set({ tenantId: "a" }, "b:c", "second");
    expect(cache.get({ tenantId: "a:b" }, "c")).toBe("first");
    expect(cache.get({ tenantId: "a" }, "b:c")).toBe("second");
    expect(cache.size).toBe(2);
  });

  it("would collide under naive delimiter joining (the bug the composite key avoids)", () => {
    const naive = (tenant: string, key: string) => `${tenant}:${key}`;
    expect(naive("a:b", "c")).toBe(naive("a", "b:c"));
    expect(ScopedCache.keyFor({ tenantId: "a:b" }, "c")).not.toBe(ScopedCache.keyFor({ tenantId: "a" }, "b:c"));
  });
});
