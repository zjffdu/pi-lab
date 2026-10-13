import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { businessActionIdFor, RequestBindings } from "../src/correlation.js";
import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { createGetBookingTool } from "../src/get-booking-tool.js";
import { verifyMechanism, type MechanismEvidence } from "../src/run-result.js";
import { openSessionStorage } from "../src/session-store.js";
import { answerTurn, ctx, scriptedRuntime, tempSessionsRoot, toolCallTurn } from "./support/scripted-runtime.js";

describe("RequestBindings", () => {
  const request = { requestId: "req-1", sessionId: "s-1" };

  it("holds the request in flight per conversation and forgets it once cleared", () => {
    const bindings = new RequestBindings();
    bindings.set(1, request);
    expect(bindings.current(1)).toEqual(request);
    expect(bindings.current(2)).toBeNull(); // a different conversation has none
    bindings.clear(1);
    expect(bindings.current(1)).toBeNull();
  });

  it("returns null — never an invented id — when nothing is in flight", () => {
    expect(new RequestBindings().current(1)).toBeNull();
  });

  it("refuses a second request on a conversation that already has one in flight", () => {
    const bindings = new RequestBindings();
    bindings.set(1, request);
    expect(() => bindings.set(1, { ...request, requestId: "req-2" })).toThrow(/still in flight/);
    bindings.clear(1);
    expect(() => bindings.set(1, { ...request, requestId: "req-2" })).not.toThrow();
  });

  it("derives a deterministic business-action id from the conversation and the tool task", () => {
    expect(businessActionIdFor(1, 12)).toBe(businessActionIdFor(1, 12));
    expect(businessActionIdFor(1, 12)).not.toBe(businessActionIdFor(1, 13));
    expect(businessActionIdFor(1, 12)).not.toBe(businessActionIdFor(2, 12));
  });
});

describe("what Pi 1.1 does and does not give a tool hook", () => {
  it("a beforeTool hook gets the call, a conversation id, and a task id — and no session id, request id, run id, lane, or turn id", async () => {
    let apiKeys: string[] = [];
    let callKeys: string[] = [];
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "booking",
        tools: [createGetBookingTool(BookingRepository.fromDefaultFixture())],
        sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
        hooks: [
          hook(ToolTask, {
            beforeTool: (call, api) => {
              callKeys = Object.keys(call).sort();
              apiKeys = Object.keys(api);
              return undefined;
            },
          }),
        ],
      }),
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("ok")]);
    const { storage } = await openSessionStorage(await tempSessionsRoot(), "keys", ctx);
    const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false, backgroundTokens: 0 } } }, ctx);
    const model = faux.getModel();
    const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });

    await (await root.submit({ type: "input", content: "go", requestId: "req-keys" }, ctx)).wait(ctx);

    expect(apiKeys).toEqual(expect.arrayContaining(["taskId", "conversationId"]));
    for (const missing of ["requestId", "sessionId", "runId", "lane", "turnId", "submissionId"]) {
      expect(apiKeys).not.toContain(missing);
      expect(callKeys).not.toContain(missing);
    }
    expect(callKeys).toEqual(["arguments", "id", "name", "type"]);
    await harness.close(ctx);
  });

  it("a tool task is not linked to its submission by any id: its owner is the generation task, whose input is empty", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("ok"));
    const result = await h.runtime.request("req-owner", "go");

    const toolTask = await h.runtime.harness.getTask(result.toolOutcomes[0]!.taskId as never, ctx);
    const owner = await h.runtime.harness.getTask(toolTask!.owner as never, ctx);

    expect(toolTask?.kind).toBe("pi.tool");
    expect(toolTask?.input).toMatchObject({ callId: "call-1" });
    expect(owner?.kind).toBe("pi.generation");
    expect(owner?.input).toEqual({});
  });
});

describe("every audit record carries the identities the application joins on", () => {
  it("requestId, sessionId, conversationId, task id, and call id — and the join to the request is re-derived from durable state", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "call-w"), answerTurn("done"));

    const result = await h.runtime.request("req-join", "go");

    for (const record of h.runtime.auditRecords) {
      expect(record).toMatchObject({
        requestId: "req-join",
        sessionId: "session-1",
        conversationId: result.correlation.conversationId,
        taskId: result.toolOutcomes[0]?.taskId,
        toolCallId: "call-w",
      });
    }
    expect(result.mechanism.ok).toBe(true); // includes the durable join: the task's assistant entry lies inside this request
  });

  it("a run not started through request() is audited with requestId null, never an invented id", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("ok"));

    await (await h.runtime.root.submit({ type: "input", content: "direct" }, ctx)).wait(ctx);

    expect(h.runtime.auditRecords.map((r) => r.requestId)).toEqual([null, null]);
  });
});

function evidence(overrides: Partial<MechanismEvidence> = {}): MechanismEvidence {
  return {
    requestId: "req-1",
    operationStatus: "completed",
    auditRecords: [],
    auditJoins: [],
    effects: [],
    toolOutcomes: [],
    governanceInstalled: true,
    backstopHits: [],
    telemetry: { runSpanFound: true, runSpanSettled: true, errorRequestSpanFound: false, bridgeWarnings: [] },
    ...overrides,
  };
}

const AUDIT = {
  at: "t",
  sessionId: "s",
  conversationId: 1,
  taskId: 12,
  toolCallId: "c",
  toolName: "get_booking",
  phase: "before_tool" as const,
  decision: "allowed" as const,
};

describe("verifyMechanism: each cross-component invariant, on synthetic evidence", () => {
  it("passes when nothing is wrong", () => {
    expect(verifyMechanism(evidence())).toEqual({ ok: true, problems: [], checked: true });
  });

  it("fails an audit record whose request id is not this request's", () => {
    const result = verifyMechanism(evidence({ auditRecords: [{ ...AUDIT, requestId: "req-OTHER" }] }));
    expect(result.problems).toEqual(["audit record for task 12 carries requestId=req-OTHER, expected req-1"]);
  });

  it("fails an audit record whose task does not resolve into this request", () => {
    const result = verifyMechanism(evidence({ auditJoins: [{ taskId: 12, inRequest: false }] }));
    expect(result.problems).toEqual(["audit record's task 12 does not resolve to a tool call inside this request"]);
  });

  it("does not expect an audit record for a call Pi refused before any hook ran", () => {
    const outcomes = (["unavailable", "invalid_arguments"] as const).map((status) => ({ toolCallId: "c", toolName: "t", status }));
    expect(verifyMechanism(evidence({ toolOutcomes: outcomes })).ok).toBe(true);
  });

  it("fails a tool call with no result entry", () => {
    const result = verifyMechanism(evidence({ toolOutcomes: [{ toolCallId: "c", toolName: "t", status: "unresolved" }] }));
    expect(result.problems).toEqual(["tool call c (t) has no result entry"]);
  });
});
