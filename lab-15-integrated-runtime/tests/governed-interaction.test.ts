import { describe, expect, it } from "vitest";

import { evaluateBehavior } from "../src/run-result.js";
import { listEntries } from "../src/transcript.js";
import { answerTurn, ctx, scriptedRuntime, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * Implementation step 1: one governed read/write interaction through the real `Harness`, and the correlated
 * evidence it leaves behind. Rejection, dependency failure, reopen, and egress are separate files.
 */

describe("governed read interaction", () => {
  it("is followable from request through submission, policy, tool, audit, and telemetry to the answer", async () => {
    const { runtime, telemetry, respondWith, faux } = await scriptedRuntime();
    respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-read-1"), answerTurn("BK1001 is booked."));

    const result = await runtime.request("req-1", "What is the status of BK1001?");

    expect(result.operation).toEqual({ status: "completed" });
    expect(result.assistantAnswer).toBe("BK1001 is booked.");
    expect(result.toolOutcomes).toEqual([
      expect.objectContaining({ toolCallId: "call-read-1", toolName: "get_booking", status: "ok" }),
    ]);
    expect(result.businessEffects).toEqual([]);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    expect(faux.state.callCount).toBe(2);

    // Application identities (request, session) and Pi identities (conversation, task, call) meet in the audit trail.
    expect(runtime.auditRecords.map((r) => [r.phase, r.decision])).toEqual([
      ["before_tool", "allowed"],
      ["after_tool", "executed"],
    ]);
    const taskId = result.toolOutcomes[0]?.taskId;
    expect(taskId).toBeDefined();
    for (const record of runtime.auditRecords) {
      expect(record).toMatchObject({
        requestId: "req-1",
        sessionId: "session-1",
        conversationId: result.correlation.conversationId,
        taskId,
        toolCallId: "call-read-1",
      });
      expect(record.businessActionId).toBeUndefined(); // a read has no business action
    }

    const runSpan = telemetry.getSpans().find((s) => s.name === "lab.run");
    expect(runSpan?.settled).toBe(true);
    expect(telemetry.getSpans().filter((s) => s.name === "lab.tool")).toHaveLength(1);
  });
});

describe("governed write interaction", () => {
  it("records exactly one business effect for the whole booking, linked to its audit trail by business-action id", async () => {
    const { runtime, respondWith } = await scriptedRuntime();
    respondWith(
      toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-read-1"),
      toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "call-write-1"),
      answerTurn("BK1001 is now in_transit."),
    );

    const result = await runtime.request("req-2", "Set BK1001 to in_transit.");

    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    expect(result.businessEffects).toHaveLength(1);
    const [effect] = result.businessEffects;
    // BK1001 carries two containers; a status belongs to the booking, so the one effect covers both.
    expect(effect).toMatchObject({
      bookingNo: "BK1001",
      previousStatus: "booked",
      newStatus: "in_transit",
      toolCallId: "call-write-1",
      containerNos: ["MSKU1234567", "MSKU2345678"],
    });
    expect(runtime.repository.findByBookingNo("BK1001")?.status).toBe("in_transit");

    const writeAudit = runtime.auditRecords.filter((r) => r.toolCallId === "call-write-1");
    expect(writeAudit.map((r) => r.decision)).toEqual(["allowed", "executed"]);
    expect(writeAudit.every((r) => r.businessActionId === effect?.businessActionId)).toBe(true);

    expect(evaluateBehavior(result, { effects: [{ bookingNo: "BK1001", newStatus: "in_transit" }], answerIncludes: ["in_transit"] })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it("keeps assistant answer, tool outcome, and business effect as three separate facts", async () => {
    const { runtime, respondWith } = await scriptedRuntime();
    // The model *claims* a change but never calls the write tool.
    respondWith(answerTurn("Done — BK1001 is now in_transit."));

    const result = await runtime.request("req-3", "Set BK1001 to in_transit.");

    expect(result.assistantAnswer).toContain("in_transit");
    expect(result.toolOutcomes).toEqual([]);
    expect(result.businessEffects).toEqual([]);
    expect(result.mechanism.ok).toBe(true); // the machinery worked...
    expect(evaluateBehavior(result, { effects: [{ bookingNo: "BK1001", newStatus: "in_transit" }] }).ok).toBe(false); // ...the behavior did not.
  });

  it("takes the answer from the entry Pi recorded for the submission, never an earlier preamble", async () => {
    const { runtime, respondWith } = await scriptedRuntime();
    respondWith(
      // One assistant message that says something AND calls a tool: the text is a preamble, not the answer.
      toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-read-1", "Let me check that booking."),
      answerTurn("BK1001 is booked."),
    );

    const result = await runtime.request("req-4", "Status of BK1001?");

    expect(result.assistantAnswer).toBe("BK1001 is booked.");
    expect(result.assistantAnswer).not.toContain("Let me check");
  });
});

describe("evidence is durable, not just in-memory", () => {
  it("the submission's own request id is stored, and every entry of the request lies between its input and answer", async () => {
    const { runtime, storage, respondWith } = await scriptedRuntime();
    respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-read-1"), answerTurn("ok"));

    const result = await runtime.request("req-5", "Status of BK1001?");

    const record = await storage.submissionByRequest(runtime.root.id, "req-5", ctx);
    expect(record).toMatchObject({ requestId: "req-5", status: "done" });
    const entries = await listEntries(runtime.root, ctx);
    const toolResult = entries.find((e) => e.kind === "pi.tool-result");
    expect(Number(toolResult?.id)).toBeGreaterThan(Number(record?.entry));
    expect(Number(toolResult?.id)).toBeLessThan(Number(record?.answer));
    expect(result.correlation.submissionId).toBe(Number(record?.id));
  });
});

describe("contract: removing a required component is detected", () => {
  it("a governance extension built without its hooks lets a write run unaudited, and the mechanism check says so", async () => {
    const { runtime, respondWith } = await scriptedRuntime({ omitForContractTest: ["governance-hooks"] });
    respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "call-write-1"), answerTurn("done"));

    const result = await runtime.request("req-6", "Set BK1001 to in_transit.");

    expect(result.businessEffects).toHaveLength(1);
    expect(result.mechanism.ok).toBe(false);
    expect(result.mechanism.problems).toEqual(
      expect.arrayContaining([
        "governance hooks are not installed",
        expect.stringMatching(/business effect .* has no allowed before_tool audit record/),
        expect.stringMatching(/executed without an allowed before_tool audit record/),
      ]),
    );
  });

  it("a runtime without telemetry reports the missing component", async () => {
    const { runtime, respondWith } = await scriptedRuntime({ omitForContractTest: ["telemetry"] });
    respondWith(answerTurn("hi"));

    const result = await runtime.request("req-7", "hello");

    expect(result.mechanism.ok).toBe(false);
    expect(result.mechanism.problems).toContain("telemetry is not installed");
  });
});
