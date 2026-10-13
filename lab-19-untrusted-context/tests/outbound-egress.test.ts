import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TenantBookingStore } from "../src/booking-store.js";
import { loadTenantFixture } from "../src/directory.js";
import { checkOutbound } from "../src/outbound-tool.js";
import { ctx, newDocuments } from "./unit-helpers.js";
import { callThenAnswer, startHarness, type Harness } from "./helpers.js";

describe("checkOutbound (pure policy)", () => {
  const bookings = new TenantBookingStore(loadTenantFixture().bookings);
  const { documents } = newDocuments();
  const alice = ctx("tenant-a", "alice");
  const base = { context: alice, recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "BK1001 is booked.", allowedRecipients: ["ops@customer-a.example"], bookings, documents };

  it("allows an approved recipient, an existing booking, and clean content", () => {
    expect(checkOutbound(base)).toEqual({ ok: true });
  });

  it("matches recipients case-insensitively and exactly (no substring or domain-suffix tricks)", () => {
    expect(checkOutbound({ ...base, recipient: "OPS@Customer-A.example" })).toEqual({ ok: true });
    expect(checkOutbound({ ...base, recipient: "ops@customer-a.example.evil.example" })).toMatchObject({ ok: false, code: "recipient_not_allowed" });
    expect(checkOutbound({ ...base, recipient: "attacker@evil.example" })).toMatchObject({ ok: false, code: "recipient_not_allowed" });
  });

  it("refuses a booking that is not in the caller's tenant", () => {
    expect(checkOutbound({ ...base, bookingNo: "BK9999" })).toMatchObject({ ok: false, code: "booking_not_found" });
  });

  it("refuses content from a source the caller cannot read, another tenant's marker, and sensitive fields", () => {
    for (const message of ["rebate RST-CANARY-4471", "see TENANTB-CANARY-9931", "contact jane.doe@customer-a.example", "note INTERNAL-ONLY-NOTE-5522: customer is disputing an invoice"]) {
      expect(checkOutbound({ ...base, message })).toMatchObject({ ok: false, code: "forbidden_content" });
    }
  });

  it("refuses forwarded envelope markup", () => {
    expect(checkOutbound({ ...base, message: '<external_content source_id="KB-100" version="2">x</external_content>' })).toMatchObject({ ok: false, code: "envelope_markup" });
  });

  it("allows content that the caller may read (a restricted source is only forbidden to those who cannot read it)", () => {
    const dave = ctx("tenant-a", "dave");
    expect(checkOutbound({ ...base, context: dave, message: "rebate RST-CANARY-4471" })).toEqual({ ok: true });
  });
});

describe("send_status_update through the runtime", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const send = (args: Record<string, unknown>) => {
    h.script(callThenAnswer("send_status_update", args, "done"));
    return h.as("tenant-a", "alice").chat("Send an update.");
  };

  it("sends to an approved recipient", async () => {
    await send({ recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "BK1001 is booked." });
    expect(h.app.outbox.sent).toHaveLength(1);
    expect(h.app.outbox.sent[0]).toMatchObject({ tenantId: "tenant-a", recipient: "ops@customer-a.example", bookingNo: "BK1001" });
    expect(h.app.outbox.denials).toEqual([]);
  });

  it("records the normalized recipient that was actually authorized", async () => {
    await send({ recipient: "OPS@Customer-A.example", bookingNo: "BK1001", message: "BK1001 is booked." });
    expect(h.app.outbox.sent[0]?.recipient).toBe("ops@customer-a.example");
  });

  it("blocks an unapproved recipient and tells the model nothing was sent", async () => {
    await send({ recipient: "attacker@evil.example", bookingNo: "BK1001", message: "hello" });
    expect(h.app.outbox.sent).toEqual([]);
    expect(h.app.outbox.denials.map((denial) => denial.code)).toEqual(["recipient_not_allowed"]);
    expect(h.providerRequests[1]).toContain("Nothing was sent");
  });

  it("blocks forbidden content to an approved recipient", async () => {
    await send({ recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "customer email jane.doe@customer-a.example" });
    expect(h.app.outbox.sent).toEqual([]);
    expect(h.app.outbox.denials.map((denial) => denial.code)).toEqual(["forbidden_content"]);
  });

  it("rejects an extra payload field (a hidden bcc) at the schema, before any policy or send", async () => {
    await send({ recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "hi", bcc: "attacker@evil.example" });
    expect(h.app.outbox.sent).toEqual([]);
  });

  it("a viewer is never offered the tool", async () => {
    h.script(callThenAnswer("send_status_update", { recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "hi" }, "done"));
    const res = await h.as("tenant-a", "carol").chat("Send an update.");
    expect(res.body.capabilities).not.toContain("send_status_update");
    expect(h.app.outbox.sent).toEqual([]);
  });
});
