import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertModelAvailable, modelSelectionFromEnvironment } from "../src/create-harness.js";
import { isBooking, loadTenantFixture } from "../src/directory.js";
import { sessionDirectory } from "../src/session-store.js";
import { booking, count } from "./db-helpers.js";
import { callThenAnswer, proposeThenAnswer, startHarness, type Harness } from "./helpers.js";

const HOLD = { bookingNo: "BK1001", newStatus: "on_hold", reason: "customs hold" };

describe("model selection", () => {
  it("uses the documented DeepSeek Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
  });

  // `deepseek-v4-flash` was the Pi 0.85.1 id; neither tsc nor a string comparison notices it is gone.
  it("resolves the default through the real Pi 1.1 catalog, and names real ids when it cannot", () => {
    expect(() => assertModelAvailable(builtinModels(), modelSelectionFromEnvironment({}))).not.toThrow();
    expect(() => assertModelAvailable(builtinModels(), { provider: "deepseek", modelId: "deepseek-v4-flash" })).toThrow(
      /Unknown model deepseek\/deepseek-v4-flash\. Available model ids include: .*deepseek-flash/,
    );
  });
});

describe("booking definition: one booking, several containers", () => {
  it("validates containerNos as a non-empty array of non-empty strings", () => {
    const base = { tenantId: "t", bookingNo: "B1", origin: "a", destination: "b", vessel: "v", plannedDeparture: "d", plannedArrival: "d", status: "booked" };
    expect(isBooking({ ...base, containerNos: ["C1", "C2"] })).toBe(true);
    expect(isBooking({ ...base, containerNos: [] })).toBe(false);
    expect(isBooking({ ...base, containerNos: [""] })).toBe(false);
    expect(isBooking({ ...base, containerNos: "C1" })).toBe(false);
    expect(isBooking({ ...base, containerNo: "C1" })).toBe(false);
  });

  it("the fixture gives a booking two containers", () => {
    const first = loadTenantFixture().bookings.find((b) => b.tenantId === "tenant-a" && b.bookingNo === "BK1001");
    expect(first?.containerNos).toHaveLength(2);
  });
});

describe("session storage layout", () => {
  it("keeps tenant and session in the path, and refuses empty ids", () => {
    expect(sessionDirectory("/root", "tenant-a", "s1")).toBe("/root/tenant-a/s1");
    expect(sessionDirectory("/root", "tenant-a", "s1")).not.toBe(sessionDirectory("/root", "tenant-b", "s1"));
    expect(() => sessionDirectory("/root", "", "s1")).toThrow();
    expect(() => sessionDirectory("/root", "tenant-a", "")).toThrow();
  });
});

describe("on Pi 1.1", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.db.reset();
    h.traceLines.length = 0;
    h.providerRequests.length = 0;
    h.runFailures.length = 0;
    h.reports.length = 0;
  });

  const alice = () => h.as("tenant-a", "alice");
  const trace = () => h.traceLines.join("\n");

  describe("multi-container booking in the database", () => {
    it("stores a booking's containers as an array, and an approved action changes the booking, not a container", async () => {
      const row = await h.db.pool.query<{ container_nos: string[] }>("SELECT container_nos FROM bookings WHERE tenant_id = 'tenant-a' AND booking_no = 'BK1001'");
      expect(row.rows[0]?.container_nos).toEqual(["MSKU1111111", "MSKU1111112"]);

      h.script(proposeThenAnswer(HOLD, "pending"));
      const proposal = (await alice().chat("hold BK1001")).body.proposals[0] as { actionId: string; digest: string };
      await h.as("tenant-a", "bob").post(`/v1/actions/${proposal.actionId}/approve`, { digest: proposal.digest });
      await alice().post(`/v1/actions/${proposal.actionId}/execute`);

      expect(await booking(h.db.pool, "tenant-a", "BK1001")).toEqual({ status: "on_hold", version: 2 });
      const after = await h.db.pool.query<{ container_nos: string[] }>("SELECT container_nos FROM bookings WHERE tenant_id = 'tenant-a' AND booking_no = 'BK1001'");
      expect(after.rows[0]?.container_nos).toEqual(["MSKU1111111", "MSKU1111112"]);
    });

    it("the database refuses a booking with no containers, and the old single column is gone", async () => {
      await expect(h.db.pool.query("UPDATE bookings SET container_nos = '{}' WHERE booking_no = 'BK2001'")).rejects.toThrow(/nonempty/);
      await expect(h.db.pool.query("SELECT container_no FROM bookings")).rejects.toThrow(/container_no/);
    });
  });

  describe("tracer", () => {
    it("shows the tool-call arguments on both the model's request and Pi's execution, paired by call id", async () => {
      h.script(proposeThenAnswer(HOLD, "pending", "call-7"));
      await alice().chat("hold BK1001");
      const args = JSON.stringify(HOLD);
      expect(trace()).toContain(`assistant (tool call) propose_booking_status_change call=call-7 args=${args}`);
      expect(trace()).toContain(`▶ tool_start propose_booking_status_change call=call-7 args=${args}`);
      expect(trace()).toContain("◀ tool_end propose_booking_status_change call=call-7 status=success");
      expect(trace()).toMatch(/▶ run[\s\S]*▶ turn #1[\s\S]*◀ turn_end #1[\s\S]*▶ turn #2[\s\S]*◀ run_end/);
    });

    it("tags every line with the request, tenant, and subject", async () => {
      h.script(proposeThenAnswer(HOLD, "pending"));
      const response = await alice().chat("hold BK1001");
      const prefix = `[req=${String(response.body.requestId).slice(0, 8)} tenant-a/alice] `;
      expect(h.traceLines.length).toBeGreaterThan(5);
      expect(h.traceLines.every((line) => line.startsWith(prefix))).toBe(true);
    });

    it("tells apart three ways a call ends in an error", async () => {
      // 1. Extra arguments: refused by the schema before the tool starts.
      h.script(callThenAnswer("propose_booking_status_change", { ...HOLD, approvedBy: "bob", state: "approved" }, "no"));
      await alice().chat("hold it");
      expect(trace()).toMatch(/⊘ tool_refused propose_booking_status_change call=call-1 code=invalid_arguments/);
      expect(trace()).not.toContain("▶ tool_start");

      // 2. A tool that is not offered at all.
      h.traceLines.length = 0;
      h.script(callThenAnswer("approve_action", { actionId: "x" }, "no"));
      await alice().chat("approve it");
      expect(trace()).toMatch(/⊘ tool_refused approve_action call=call-1 code=tool_unavailable/);
      expect(trace()).not.toContain("▶ tool_start");

      // 3. The tool ran and refused the caller: a start, an end, and the reason.
      h.traceLines.length = 0;
      h.script(proposeThenAnswer(HOLD, "no"));
      await h.as("tenant-a", "carol").chat("hold it");
      expect(trace()).toContain("▶ tool_start propose_booking_status_change");
      expect(trace()).toMatch(/◀ tool_end propose_booking_status_change call=call-1 status=error code=tool_error reason="You are not permitted to propose booking changes\."/);
      expect(trace()).not.toContain("⊘");

      expect(await count(h.db.pool, "actions")).toBe(0);
    });

    it("keeps two concurrent requests distinguishable in one log", async () => {
      h.script([...proposeThenAnswer(HOLD, "a"), ...proposeThenAnswer({ ...HOLD, bookingNo: "BK2001" }, "b", "call-2")]);
      const [first, second] = await Promise.all([alice().chat("hold BK1001"), h.as("tenant-a", "dave").chat("hold BK2001")]);
      expect([first.status, second.status]).toEqual([200, 200]);
      const tags = new Set(h.traceLines.map((line) => /^\[[^\]]+\]/.exec(line)?.[0]));
      expect(tags.size).toBe(2);
    });
  });

  describe("roles are the current caller's, not the session's", () => {
    it("a reopened session cannot keep proposing after the operator role is revoked", async () => {
      h.script(proposeThenAnswer(HOLD, "pending"));
      const first = await alice().chat("hold BK1001");
      expect(first.body.proposals).toHaveLength(1);
      const sessionId = first.body.sessionId as string;

      h.directory.revokeRole("tenant-a", "alice", "operator");
      try {
        h.script(proposeThenAnswer({ ...HOLD, bookingNo: "BK2001" }, "refused", "call-2"));
        const second = await alice().chat("now hold BK2001", sessionId);
        expect(second.status).toBe(200);
        expect(second.body.proposals).toEqual([]);
        expect(await count(h.db.pool, "actions")).toBe(1);
        expect(trace()).toMatch(/status=error code=tool_error reason="You are not permitted/);
      } finally {
        h.directory.grantRole("tenant-a", "alice", "operator");
      }
    });

    it("keeps one conversation across requests: the second run sees the first run's history", async () => {
      h.script(proposeThenAnswer(HOLD, "pending"));
      const first = await alice().chat("hold BK1001");
      h.script([fauxAssistantMessage("It is pending.")]);
      const second = await alice().chat("what happened?", first.body.sessionId as string);
      expect(second.body.sessionId).toBe(first.body.sessionId);
      const seen = h.providerRequests.at(-1) ?? "";
      expect(seen).toContain("hold BK1001");
      expect(seen).toContain("State: pending");
    });
  });

  describe("sessions and runs", () => {
    it("serializes two simultaneous requests on one session instead of colliding", async () => {
      h.script([...proposeThenAnswer(HOLD, "first"), fauxAssistantMessage("second")]);
      const first = await alice().chat("hold BK1001");
      const sessionId = first.body.sessionId as string;

      h.script([fauxAssistantMessage("one"), fauxAssistantMessage("two")], { delayMs: 200 });
      const [a, b] = await Promise.all([alice().chat("A", sessionId), alice().chat("B", sessionId)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.answer, b.body.answer].sort()).toEqual(["one", "two"]);
      expect(h.runFailures).toEqual([]);

      // Both answering 200 proves little: without the queue, two harnesses over one storage hand both
      // user messages the same entry id and neither run sees the other's message (a forked history).
      // Serialized, the later run's provider request carries the earlier request's message as history.
      const latest = h.providerRequests.at(-1) ?? "";
      expect(latest).toContain('"content":"A"');
      expect(latest).toContain('"content":"B"');
      const userEntryIds = h.traceLines.filter((line) => /user\s+"[AB]"/.test(line)).map((line) => /entry=(\d+)/.exec(line)?.[1]);
      expect(new Set(userEntryIds).size).toBe(2);
    });

    it("turns a provider failure into a failed run, not an answer", async () => {
      h.script([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);
      const response = await alice().chat("hold BK1001");
      expect([response.status, response.body.error]).toEqual([502, "run_failed"]);
      expect(JSON.stringify(response.body)).not.toContain("exploded");
      expect(h.runFailures.join("\n")).toContain("exploded");
      expect(await count(h.db.pool, "actions")).toBe(0);
    });
  });
});
