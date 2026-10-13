import { describe, expect, it } from "vitest";

import { TenantBookingStore } from "../src/booking-store.js";
import { UntrustedSecurityContextError, mintSecurityContextForTest } from "../src/security-context.js";

const store = TenantBookingStore.fromDefaultFixture();
const contextFor = (tenantId: string, subject: string) => mintSecurityContextForTest({ tenantId, subject, requestId: "r" });

describe("TenantBookingStore", () => {
  it("returns each tenant's own BK1001 — same booking number, different records", () => {
    const a = store.findByBookingNo(contextFor("tenant-a", "alice"), "BK1001");
    const b = store.findByBookingNo(contextFor("tenant-b", "carol"), "BK1001");
    expect(a).toMatchObject({ tenantId: "tenant-a", vessel: "ALPHA EXPRESS" });
    expect(b).toMatchObject({ tenantId: "tenant-b", vessel: "BRAVO VOYAGER" });
    expect(a?.containerNos).toEqual(["MSKU1111111", "MSKU1111112"]);
    expect(b?.containerNos).toEqual(["TCLU9999999", "TCLU9999998"]);
  });

  it("treats another tenant's booking number as absent", () => {
    expect(store.findByBookingNo(contextFor("tenant-b", "carol"), "BK2001")).toBeUndefined();
    expect(store.findByBookingNo(contextFor("tenant-a", "alice"), "BK9999")).toBeUndefined();
  });

  it("returns a copy, so a caller cannot mutate the stored row", () => {
    const first = store.findByBookingNo(contextFor("tenant-a", "alice"), "BK1001");
    if (first) first.vessel = "TAMPERED";
    expect(store.findByBookingNo(contextFor("tenant-a", "alice"), "BK1001")?.vessel).toBe("ALPHA EXPRESS");
  });

  it("refuses a caller that is not a server-minted SecurityContext", () => {
    const lookAlike = { tenantId: "tenant-b", subject: "carol", authSource: "local-test-token", requestId: "r" } as never;
    expect(() => store.findByBookingNo(lookAlike, "BK1001")).toThrow(UntrustedSecurityContextError);
    expect(() => store.foreignMarkers(lookAlike)).toThrow(UntrustedSecurityContextError);
  });

  it("derives foreign markers from other tenants' rows only", () => {
    const markersForA = store.foreignMarkers(contextFor("tenant-a", "alice"));
    expect(markersForA).toContain("BRAVO VOYAGER");
    // Every container of a foreign booking is a marker, not just the first.
    expect(markersForA).toContain("TCLU9999999");
    expect(markersForA).toContain("TCLU9999998");
    expect(markersForA).not.toContain("MSKU1111112");
    expect(markersForA).not.toContain("ALPHA EXPRESS");

    const markersForB = store.foreignMarkers(contextFor("tenant-b", "carol"));
    expect(markersForB).toContain("ALPHA EXPRESS");
    expect(markersForB).not.toContain("BRAVO VOYAGER");
  });
});
