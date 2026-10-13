import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertModelAvailable, modelSelectionFromEnvironment } from "../src/create-harness.js";
import { isBooking, loadTenantFixture } from "../src/directory.js";
import { sessionDirectory } from "../src/session-store.js";
import { BASELINE_OPERATOR_TOOLS, BASELINE_READER_TOOLS, callThenAnswer, offeredToolsOf, say, startHarness, toolCall, type Harness } from "./helpers.js";

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
  const base = { tenantId: "t", bookingNo: "B1", origin: "a", destination: "b", vessel: "v", plannedDeparture: "d", plannedArrival: "d", status: "booked" };

  it("validates containerNos as a non-empty array of non-empty strings", () => {
    expect(isBooking({ ...base, containerNos: ["C1", "C2"] })).toBe(true);
    expect(isBooking({ ...base, containerNos: [] })).toBe(false);
    expect(isBooking({ ...base, containerNos: [""] })).toBe(false);
    expect(isBooking({ ...base, containerNos: "C1" })).toBe(false);
    expect(isBooking({ ...base, containerNo: "C1" })).toBe(false);
  });

  it("the fixture gives a booking two containers, and every booking has at least one", () => {
    const { bookings } = loadTenantFixture();
    expect(bookings.find((b) => b.tenantId === "tenant-a" && b.bookingNo === "BK1001")?.containerNos).toHaveLength(2);
    expect(bookings.every((b) => b.containerNos.length >= 1)).toBe(true);
  });
});

describe("session storage layout", () => {
  it("keeps tenant and session in the path, and refuses empty ids", () => {
    expect(sessionDirectory("/root", "tenant-a", "s1")).toBe("/root/tenant-a/s1");
    expect(sessionDirectory("/root", "tenant-a", "s1")).not.toBe(sessionDirectory("/root", "tenant-b", "s1"));
    expect(() => sessionDirectory("/root", "", "s1")).toThrow();
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
  beforeEach(() => {
    h.traceLines.length = 0;
    h.providerRequests.length = 0;
    h.providerMessages.length = 0;
    h.runFailures.length = 0;
    h.reports.length = 0;
  });

  const alice = () => h.as("tenant-a", "alice");
  const carol = () => h.as("tenant-a", "carol");
  const trace = () => h.traceLines.join("\n");

  describe("tracer", () => {
    it("shows the tool-call arguments on both the model's request and Pi's execution, paired by call id", async () => {
      h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "See [KB-100@2].", "call-7"));
      await carol().chat("procedure?");
      const args = JSON.stringify({ query: "procedure broker clearance" });
      expect(trace()).toContain(`assistant (tool call) search_documents call=call-7 args=${args}`);
      expect(trace()).toContain(`▶ tool_start search_documents call=call-7 args=${args}`);
      expect(trace()).toContain("◀ tool_end search_documents call=call-7 status=success");
      expect(trace()).toMatch(/▶ run[\s\S]*▶ turn #1[\s\S]*◀ turn_end #1[\s\S]*▶ turn #2[\s\S]*◀ run_end/);
    });

    it("names the sources a document result carried, with stale and conflicting evidence marked", async () => {
      h.script(callThenAnswer("search_documents", { query: "BK1001 customs status" }, "They disagree."));
      await carol().chat("customs status?");
      expect(trace()).toMatch(/toolResult search_documents status=success sources=\[[^\]]*NOTE-BK1001-A@1[^\]]*NOTE-BK1001-B@1[^\]]*\] conflicts=1 entry=\d+/);

      h.traceLines.length = 0;
      h.script(callThenAnswer("read_document", { sourceId: "SCHED-2024" }, "Old."));
      await carol().chat("schedule?");
      expect(trace()).toMatch(/toolResult read_document status=success sources=\[SCHED-2024@1\] stale=\[SCHED-2024@1\]/);
    });

    it("tags every line with the request, tenant, and subject", async () => {
      h.script([say("hi")]);
      const response = await alice().chat("hello");
      const prefix = `[req=${String(response.body.requestId).slice(0, 8)} tenant-a/alice] `;
      expect(h.traceLines.length).toBeGreaterThan(3);
      expect(h.traceLines.every((line) => line.startsWith(prefix))).toBe(true);
    });

    it("tells apart three ways a call ends in an error", async () => {
      // 1. Extra arguments: refused by the schema before the tool starts.
      h.script(callThenAnswer("search_documents", { query: "x", tenantId: "tenant-b" }, "no"));
      await carol().chat("search");
      expect(trace()).toMatch(/⊘ tool_refused search_documents call=call-1 code=invalid_arguments/);
      expect(trace()).not.toContain("▶ tool_start");

      // 2. A tool that is not offered to this caller: a viewer cannot propose.
      h.traceLines.length = 0;
      h.script(callThenAnswer("propose_booking_status_change", { bookingNo: "BK1001", newStatus: "on_hold", reason: "r" }, "no"));
      await carol().chat("hold it");
      expect(trace()).toMatch(/⊘ tool_refused propose_booking_status_change call=call-1 code=tool_unavailable/);
      expect(trace()).not.toContain("▶ tool_start");

      // 3. The tool ran and refused: a start, an end, and the reason.
      h.traceLines.length = 0;
      h.script(callThenAnswer("read_document", { sourceId: "NOPE-1" }, "no"));
      await carol().chat("read it");
      expect(trace()).toContain("▶ tool_start read_document");
      expect(trace()).toMatch(/◀ tool_end read_document call=call-1 status=error code=tool_error reason="No accessible document with ID/);
      expect(trace()).not.toContain("⊘");
      expect(h.app.ledger.proposals).toEqual([]);
    });

    it("keeps two concurrent requests distinguishable in one log", async () => {
      h.script([...callThenAnswer("search_documents", { query: "procedure broker clearance" }, "a"), ...callThenAnswer("search_documents", { query: "vessel schedule" }, "b", "call-2")]);
      const [first, second] = await Promise.all([carol().chat("one"), h.as("tenant-a", "dave").chat("two")]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(new Set(h.traceLines.map((line) => /^\[[^\]]+\]/.exec(line)?.[0])).size).toBe(2);
    });

    it("never prints a forbidden value, even one the model put in its own tool-call arguments", async () => {
      h.script(callThenAnswer("send_status_update", { recipient: "ops@customer-a.example", bookingNo: "BK1001", message: "customer jane.doe@customer-a.example, note INTERNAL-ONLY-NOTE-5522: customer is disputing an invoice" }, "no"));
      await alice().chat("send an update");
      expect(h.app.outbox.sent).toEqual([]);
      expect(trace()).toContain("assistant (tool call) send_status_update");
      expect(trace()).toContain("[withheld by egress guard]");
      for (const secret of ["jane.doe@customer-a.example", "INTERNAL-ONLY-NOTE-5522"]) expect(trace()).not.toContain(secret);
    });

    it("is off unless a trace writer is given", async () => {
      const quiet = await startHarness();
      try {
        (quiet.app.chat as unknown as { options: { trace?: unknown } }).options.trace = undefined;
        quiet.script([say("hi")]);
        await quiet.as("tenant-a", "alice").chat("hello");
        expect(quiet.traceLines).toEqual([]);
      } finally {
        await quiet.close();
      }
    });
  });

  describe("the caller's roles apply to a reopened session", () => {
    it("a conversation that once offered write tools offers only read tools after the operator role is revoked", async () => {
      const dave = () => h.as("tenant-a", "dave");
      h.script([say("hello")]);
      const first = await dave().chat("hello");
      expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual(BASELINE_OPERATOR_TOOLS);

      h.directory.revokeRole("tenant-a", "dave", "operator");
      try {
        h.providerMessages.length = 0;
        h.script(callThenAnswer("propose_booking_status_change", { bookingNo: "BK1001", newStatus: "on_hold", reason: "r" }, "refused"));
        const second = await dave().chat("now hold BK1001", first.body.sessionId as string);
        expect(second.status).toBe(200);
        expect(second.body.capabilities).toEqual(BASELINE_READER_TOOLS);
        expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual(BASELINE_READER_TOOLS);
        expect(h.app.ledger.proposals).toEqual([]);
        expect(trace()).toMatch(/⊘ tool_refused propose_booking_status_change .*code=tool_unavailable/);
      } finally {
        h.directory.grantRole("tenant-a", "dave", "operator");
      }
    });

    /**
     * Revocation is already enforced by the request's registry (a tool name it does not contain is unavailable),
     * so it cannot show whether the stored offer is re-applied. A *grant* can: a conversation created while the
     * caller was a viewer stored a read-only offer, and only `configure({ tools })` replaces it.
     */
    it("a conversation created while the caller was a viewer offers the write tools once the caller becomes an operator", async () => {
      h.script([say("hello")]);
      const first = await carol().chat("hello");
      expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual(BASELINE_READER_TOOLS);

      h.directory.grantRole("tenant-a", "carol", "operator");
      try {
        h.providerMessages.length = 0;
        h.script([say("hello again")]);
        const second = await carol().chat("again", first.body.sessionId as string);
        expect(second.body.capabilities).toEqual(BASELINE_OPERATOR_TOOLS);
        expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual(BASELINE_OPERATOR_TOOLS);
      } finally {
        h.directory.revokeRole("tenant-a", "carol", "operator");
      }
    });

    it("a known principal left with no role at all is offered no tool", async () => {
      h.directory.revokeRole("tenant-a", "alice", "operator");
      try {
        h.script([say("hello")]);
        const res = await alice().chat("hello");
        expect(res.status).toBe(200);
        expect(res.body.capabilities).toEqual([]);
        expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual([]);
      } finally {
        h.directory.grantRole("tenant-a", "alice", "operator");
      }
    });

    it("keeps one conversation across requests: the second run sees the first run's history", async () => {
      h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "Contact the broker. [KB-100@2]"));
      const first = await carol().chat("customs procedure?");
      h.script([say("It was the broker.")]);
      const second = await carol().chat("what did you say?", first.body.sessionId as string);
      expect(second.body.sessionId).toBe(first.body.sessionId);
      const seen = h.providerRequests.at(-1) ?? "";
      expect(seen).toContain("customs procedure?");
      expect(seen).toContain("Contact the broker.");
    });
  });

  describe("sessions and runs", () => {
    it("serializes two simultaneous requests on one session instead of colliding", async () => {
      h.script([say("first")]);
      const first = await carol().chat("start");
      const sessionId = first.body.sessionId as string;

      h.script([say("one"), say("two")], { delayMs: 200 });
      const [a, b] = await Promise.all([carol().chat("A", sessionId), carol().chat("B", sessionId)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.answer, b.body.answer].sort()).toEqual(["one", "two"]);
      expect(h.runFailures).toEqual([]);

      // Both answering 200 proves little: without the queue, two harnesses over one storage hand both user
      // messages the same entry id and neither run sees the other's message (a forked history). Serialized, the
      // later run's provider request carries the earlier request's message as history.
      const latest = h.providerRequests.at(-1) ?? "";
      expect(latest).toContain('"content":"A"');
      expect(latest).toContain('"content":"B"');
      const userEntryIds = h.traceLines.filter((line) => /user\s+"[AB]"/.test(line)).map((line) => /entry=(\d+)/.exec(line)?.[1]);
      expect(new Set(userEntryIds).size).toBe(2);
    });

    it("also queues history and compact behind a running chat, so they read a finished conversation", async () => {
      h.script([say("first")]);
      const first = await carol().chat("start");
      const sessionId = first.body.sessionId as string;

      h.script([say("slow answer")], { delayMs: 300 });
      const running = carol().chat("slow question", sessionId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const history = await carol().history(sessionId);
      await running;
      const texts = (history.body.messages as Array<{ text: string }>).map((message) => message.text);
      expect(texts).toContain("slow question");
      expect(texts).toContain("slow answer");
    });

    it("turns a provider failure into a failed run, not an answer", async () => {
      h.script([toolCall("search_documents", { query: "procedure broker clearance" }), { ...say(""), stopReason: "error", errorMessage: "provider exploded" } as never]);
      const res = await carol().chat("procedure?");
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("run_failed");
      expect(JSON.stringify(res.body)).not.toContain("provider exploded");
      expect(h.runFailures.join(" ")).toMatch(/model_error|provider exploded/);
    });

    it("leaves no hook failure swallowed by a healthy run", async () => {
      h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "ok [KB-100@2]"));
      await carol().chat("procedure?");
      expect(h.reports).toEqual([]);
    });
  });
});
