import { describe, expect, it } from "vitest";

import { loadTenantFixture } from "../src/directory.js";

describe("tenant fixture", () => {
  it("gives every booking a non-empty containerNos array and at least one multi-container booking", () => {
    const { bookings } = loadTenantFixture();
    for (const booking of bookings) {
      expect(Array.isArray(booking.containerNos)).toBe(true);
      expect(booking.containerNos.length).toBeGreaterThan(0);
    }
    expect(bookings.some((booking) => booking.containerNos.length > 1)).toBe(true);
  });

  it("keeps BK1001 in both tenants with different containers", () => {
    const { bookings } = loadTenantFixture();
    const [a, b] = ["tenant-a", "tenant-b"].map((tenantId) => bookings.find((booking) => booking.tenantId === tenantId && booking.bookingNo === "BK1001"));
    expect(a?.containerNos.some((containerNo) => b?.containerNos.includes(containerNo))).toBe(false);
  });
});
