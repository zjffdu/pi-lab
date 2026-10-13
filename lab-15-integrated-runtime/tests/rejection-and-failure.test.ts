import { describe, expect, it } from "vitest";

import { messageText, listEntries, errorDiagnostic } from "../src/transcript.js";
import {
  afterToolFailingAuditLog,
  alwaysFailingAuditLog,
  answerTurn,
  ctx,
  providerError,
  scriptedRuntime,
  SpyBookingRepository,
  toolCallTurn,
} from "./support/scripted-runtime.js";

/**
 * Implementation step 2: rejection and dependency-failure paths through the real `Harness`. Each expectation
 * below was established by running the injection first, not assumed — and, because Pi 1.1 is a different
 * runtime from 0.85.1, not carried over from the 0.85.1 version of this lab.
 */

const WRITE = { bookingNo: "BK1001", newStatus: "in_transit" } as const;
const CANCEL = { bookingNo: "BK1001", newStatus: "cancelled" } as const;

async function toolResultOf(h: Awaited<ReturnType<typeof scriptedRuntime>>) {
  const entries = await listEntries(h.runtime.root, ctx);
  const entry = entries.find((e) => e.kind === "pi.tool-result");
  return { entry, text: entry?.model?.[0] ? messageText(entry.model[0]) : "", code: errorDiagnostic(entry)?.code, all: entries };
}

describe("policy-blocked call", () => {
  it("creates no business effect and leaves one blocked audit record, a durable coded error result, and a refused tool span", async () => {
    const repository = new SpyBookingRepository();
    const h = await scriptedRuntime({ repository });
    h.respondWith(toolCallTurn("update_booking_status", CANCEL, "call-w1"), answerTurn("That change was rejected."));

    const result = await h.runtime.request("req-block", "Cancel BK1001.");

    expect(result.businessEffects).toEqual([]);
    expect(repository.statusChanges).toEqual([]);
    expect(repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(result.toolOutcomes).toEqual([expect.objectContaining({ toolCallId: "call-w1", status: "blocked", code: "blocked" })]);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });

    // Audit: the decision is recorded; afterTool never runs for a call that never executed.
    expect(h.runtime.auditRecords.map((r) => [r.phase, r.decision])).toEqual([["before_tool", "blocked"]]);
    expect(h.runtime.auditRecords[0]?.reason).toMatch(/not permitted/i);
    // The business-action id names the *attempt*: a blocked call has one, and only the (empty) ledger says nothing happened.
    expect(h.runtime.auditRecords[0]?.businessActionId).toBe(`act:${result.correlation.conversationId}:${result.toolOutcomes[0]?.taskId}`);

    // Durable: user, system, assistant (tool call), tool result (error, code=blocked), assistant (final). The reason is model-visible.
    const { text, code, all } = await toolResultOf(h);
    expect(all.map((e) => e.kind)).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"]);
    expect(code).toBe("blocked");
    expect(text).toMatch(/Tool call blocked: Cancellation is not permitted/);

    // Telemetry: Pi emits tool_execution_end with NO tool_execution_start for a refused call, which the
    // bridge records as a refused span. Telemetry says "refused"; only the audit says it was a policy decision.
    const toolSpan = h.telemetry.getSpans().find((s) => s.name === "lab.tool");
    expect(toolSpan?.attributes["lab.tool.outcome"]).toBe("refused");
    expect(toolSpan?.status).toEqual({ status: "error" });
  });

  it("blocks a change to a delivered booking with several containers, read from current state", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1003", newStatus: "in_transit" }, "call-w1"), answerTurn("rejected"));

    const result = await h.runtime.request("req-delivered", "Set BK1003 to in_transit.");

    expect(result.businessEffects).toEqual([]);
    expect(result.toolOutcomes[0]?.status).toBe("blocked");
    expect(h.runtime.auditRecords[0]?.reason).toMatch(/BK1003 is already delivered/);
    expect(h.runtime.repository.findByBookingNo("BK1003")?.status).toBe("delivered");
  });
});

describe("refused before any hook runs", () => {
  it("a tool that is not offered ends as unavailable: no audit record, no effect, and not a mechanism failure", async () => {
    const h = await scriptedRuntime({ offeredToolNames: ["get_booking"] });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("I could not do that."));

    const result = await h.runtime.request("req-unavail", "Set BK1001 to in_transit.");

    expect(result.toolOutcomes).toEqual([expect.objectContaining({ status: "unavailable", code: "tool_unavailable" })]);
    expect(h.runtime.auditRecords).toEqual([]);
    expect(result.businessEffects).toEqual([]);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
  });

  it("invalid arguments end as invalid_arguments: no audit record, no effect, and not a mechanism failure", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "teleported" }, "call-w1"), answerTurn("bad value"));

    const result = await h.runtime.request("req-badargs", "Set BK1001 to teleported.");

    expect(result.toolOutcomes).toEqual([expect.objectContaining({ status: "invalid_arguments", code: "invalid_arguments" })]);
    expect(h.runtime.auditRecords).toEqual([]);
    expect(result.businessEffects).toEqual([]);
    expect(result.mechanism.ok).toBe(true);
  });
});

describe("deny-by-default policy table", () => {
  it("blocks a tool that has no policy entry, and audits the block with a reason that names the gap", async () => {
    // Only get_booking has a policy; update_booking_status is offered but unlisted.
    const h = await scriptedRuntime({ policies: { get_booking: () => ({ allowed: true }) } });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("blocked"));

    const result = await h.runtime.request("req-nopolicy", "Set BK1001 to in_transit.");

    expect(result.toolOutcomes[0]?.status).toBe("blocked");
    expect(result.businessEffects).toEqual([]);
    expect(h.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(h.runtime.auditRecords.map((r) => [r.phase, r.decision])).toEqual([["before_tool", "blocked"]]);
    expect(h.runtime.auditRecords[0]?.reason).toMatch(/No policy is registered/);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
  });
});

describe("policy exception", () => {
  const throwing = {
    get_booking: () => ({ allowed: true }),
    update_booking_status: () => {
      throw new Error("policy bug");
    },
  };

  it("fails closed: no effect, no audit record — and the call still ends as blocked, so only the audit check can tell", async () => {
    const h = await scriptedRuntime({ policies: throwing });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("That was blocked."));

    const result = await h.runtime.request("req-exc", "Set BK1001 to in_transit.");

    expect(result.businessEffects).toEqual([]);
    expect(h.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(h.runtime.auditRecords).toEqual([]);
    expect(result.toolOutcomes[0]).toMatchObject({ status: "blocked", code: "blocked" }); // same as a deliberate decline
    expect(result.mechanism.ok).toBe(false);
    expect(result.mechanism.problems).toEqual([
      "tool call call-w1 (update_booking_status) was blocked but no blocked decision was audited (a policy exception or an audit-sink failure)",
    ]);
  });

  it("exposes the internal exception message to the model through the durable tool result (known limitation)", async () => {
    const h = await scriptedRuntime({ policies: throwing });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("blocked"));
    await h.runtime.request("req-leak", "go");

    expect((await toolResultOf(h)).text).toContain("policy bug");
  });
});

describe("audit sink unavailable", () => {
  it("blocks a write (fail-closed): no effect, nothing audited, mechanism reports it", async () => {
    const h = await scriptedRuntime({ auditLog: alwaysFailingAuditLog() });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("blocked"));

    const result = await h.runtime.request("req-sink-w", "go");

    expect(result.businessEffects).toEqual([]);
    expect(h.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(h.runtime.auditRecords).toEqual([]);
    expect(result.toolOutcomes[0]?.status).toBe("blocked");
    expect(result.mechanism.ok).toBe(false);
  });

  it("also blocks a read: this lab governs the read tool too, so audit downtime stops all tool use", async () => {
    const h = await scriptedRuntime({ auditLog: alwaysFailingAuditLog() });
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-r1"), answerTurn("could not read"));

    const result = await h.runtime.request("req-sink-r", "go");

    expect(result.toolOutcomes[0]?.status).toBe("blocked");
    expect(result.mechanism.problems).toEqual([
      "tool call call-r1 (get_booking) was blocked but no blocked decision was audited (a policy exception or an audit-sink failure)",
    ]);
  });

  it("does not stop a conversation that uses no tools", async () => {
    const h = await scriptedRuntime({ auditLog: alwaysFailingAuditLog() });
    h.respondWith(answerTurn("Hello."));

    const result = await h.runtime.request("req-sink-plain", "hello");

    expect(result.operation.status).toBe("completed");
    expect(result.assistantAnswer).toBe("Hello.");
    expect(result.mechanism.ok).toBe(true);
  });

  it("fails open when only the afterTool write fails: the effect happens, the harness reports the swallowed throw, and the mechanism check reports the missing audit", async () => {
    const h = await scriptedRuntime({ auditLog: afterToolFailingAuditLog() });
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), answerTurn("Done."));

    const result = await h.runtime.request("req-sink-after", "go");

    expect(result.businessEffects).toHaveLength(1); // the effect stands
    expect(h.runtime.repository.findByBookingNo("BK1001")?.status).toBe("in_transit");
    expect(h.runtime.auditRecords.map((r) => r.phase)).toEqual(["before_tool"]); // only records the sink accepted
    expect(h.runtime.reports).toHaveLength(1);
    expect(String((h.runtime.reports[0] as Error).message)).toMatch(/after_tool only/);
    expect(result.mechanism.ok).toBe(false);
    expect(result.mechanism.problems).toEqual([
      "tool call call-w1 (update_booking_status) executed but its after_tool audit record is missing",
    ]);
  });
});

describe("provider failure", () => {
  it("settles the submission unanswered with Pi's reason: a failed operation with no answer, no tools, and an error request span", async () => {
    const h = await scriptedRuntime();
    h.respondWith(providerError());

    const result = await h.runtime.request("req-pf1", "hello");

    expect(result.operation).toEqual({ status: "failed", errorCode: "model_error", errorMessage: "provider exploded" });
    expect(result.assistantAnswer).toBeUndefined();
    expect(result.toolOutcomes).toEqual([]);
    expect(h.faux.state.callCount).toBe(1); // no automatic retry for this error shape
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    const requestSpan = h.telemetry.getSpans().find((s) => s.name === "lab.ai.request");
    expect(requestSpan?.attributes["lab.ai.stop_reason"]).toBe("error");
    expect(requestSpan?.status).toEqual({ status: "error" });
  });

  it("never reports an earlier preamble as the answer of a failed run", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-r1", "Let me check that booking."), providerError());

    const result = await h.runtime.request("req-pf2", "Status of BK1001?");

    expect(result.operation.status).toBe("failed");
    expect(result.assistantAnswer).toBeUndefined();
    expect(result.toolOutcomes).toEqual([expect.objectContaining({ toolCallId: "call-r1", status: "ok" })]);
  });

  it("a failed run can still carry a business effect: failure of the run is not absence of the effect", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("update_booking_status", WRITE, "call-w1"), providerError());

    const result = await h.runtime.request("req-pf3", "Set BK1001 to in_transit.");

    expect(result.operation.status).toBe("failed");
    expect(result.assistantAnswer).toBeUndefined();
    expect(result.businessEffects).toHaveLength(1);
    expect(h.runtime.repository.findByBookingNo("BK1001")?.status).toBe("in_transit");
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
  });
});
