import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { FROZEN_EVALUATION_CASES } from "../src/evaluation-cases.js";
import { runFrozenCases, type CaseRunResult } from "../src/evaluation-runner.js";
import { findByName, renderSpanTree } from "../src/span-tree.js";
import { createFauxModels, withTempSessionsRoot } from "./helpers.js";

/**
 * The whole evaluation path against the REAL `Harness`, real JSONL storage, and a scripted model: submit, run,
 * committed events, telemetry bridge, tracer, durable transcript, deterministic checks. Nothing here calls a
 * provider. These are the roadmap's failure injections on genuine runs rather than hand-built evidence — a
 * scripted model can be made to skip a lookup, double an effect, or name one container of two, on demand.
 */

type Replies = ReturnType<typeof fauxAssistantMessage>[];

async function run(caseId: string, replies: Replies, repetitions = 1, trace?: (line: string) => void): Promise<CaseRunResult[]> {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(replies);
    return runFrozenCases({
      cases: FROZEN_EVALUATION_CASES.filter((c) => c.id === caseId),
      repetitions,
      models,
      selection,
      sessionsRoot,
      ...(trace ? { trace } : {}),
    });
  });
}

const statusOf = (result: CaseRunResult, check: string) => result.checks.find((c) => c.name === check)?.status;
const lookup = (bookingNo: string, id = "c1") =>
  fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo }, { id }), { stopReason: "toolUse" });
const change = (id: string) =>
  fauxAssistantMessage(fauxToolCall("update_booking_status", { bookingNo: "BK1002", newStatus: "in_transit" }, { id }), { stopReason: "toolUse" });

describe("runFrozenCases — a well-behaved run", () => {
  it("produces the full span tree, settled, and every applicable check passes", async () => {
    const [result] = await run("lookup-single", [lookup("BK1001"), fauxAssistantMessage("BK1001 is booked and goes to NLRTM.")]);

    expect(result!.operationStatus).toBe("done");
    expect(result!.answerText).toBe("BK1001 is booked and goes to NLRTM.");
    expect(result!.telemetryWarnings).toEqual([]);
    expect(result!.spans.every((span) => span.settled)).toBe(true);
    expect(renderSpanTree(result!.spans, { "lab.tool": ["lab.tool.name", "lab.tool.replay"], "lab.ai.request": ["lab.ai.stop_reason"] })).toEqual([
      "lab.run #1",
      "  lab.turn #2",
      '    lab.ai.request #3 ai.stop_reason="toolUse"',
      '    lab.tool #4 tool.name="get_booking" tool.replay="safe"',
      "  lab.turn #5",
      '    lab.ai.request #6 ai.stop_reason="stop"',
    ]);

    const failed = result!.checks.filter((check) => check.status === "fail");
    expect(failed).toEqual([]);
    expect(statusOf(result!, "required-tool-evidence")).toBe("pass");
    expect(statusOf(result!, "token-usage")).toBe("pass");
    // The scripted provider reports no durationMs, so latency is honestly unavailable rather than 0.
    expect(statusOf(result!, "latency")).toBe("unavailable");
    expect(statusOf(result!, "unobservable:navigation")).toBe("unavailable");
  });

  it("reconstructs tool calls from the durable transcript, with arguments and result text", async () => {
    const [result] = await run("lookup-single", [lookup("BK1001"), fauxAssistantMessage("BK1001 is booked.")]);
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]).toMatchObject({ toolName: "get_booking", toolCallId: "c1", args: { bookingNo: "BK1001" }, isError: false });
    expect(JSON.parse(result!.toolCalls[0]!.resultText)).toMatchObject({ containerNos: ["MSKU1234567", "MSKU2345678"], status: "booked" });
  });

  it("writes a tagged trace per run when asked, showing the call's arguments", async () => {
    const lines: string[] = [];
    await run("lookup-single", [lookup("BK1001"), fauxAssistantMessage("ok")], 1, (line) => lines.push(line));
    expect(lines.every((line) => line.startsWith("[lookup-single#0] "))).toBe(true);
    expect(lines.some((line) => line.includes('assistant (tool call) get_booking call=c1 args={"bookingNo":"BK1001"}'))).toBe(true);
    expect(lines.some((line) => line.includes("▶ tool_start get_booking call=c1"))).toBe(true);
  });
});

describe("runFrozenCases — the roadmap's failure injections on real runs", () => {
  // "A polished but ungrounded answer cannot pass the evidence checks."
  it("fails required-tool-evidence for a fluent, correct-sounding answer that never looked anything up", async () => {
    const [result] = await run("lookup-single", [fauxAssistantMessage("BK1001 is booked and is headed to NLRTM on MAERSK TEST. Anything else?")]);

    expect(result!.operationStatus).toBe("done");
    expect(statusOf(result!, "terminal-operation-status")).toBe("pass");
    expect(statusOf(result!, "identifier-provenance")).toBe("pass"); // it names only BK1001, which the prompt named
    expect(statusOf(result!, "required-tool-evidence")).toBe("fail");
    expect(result!.toolCalls).toEqual([]);
    expect(statusOf(result!, "span:lab.tool")).toBe("fail"); // and the telemetry agrees: no tool span exists
    expect(findByName(result!.spans, "lab.tool")).toHaveLength(0);
  });

  it("fails duplicate-effects when the model changes the same status twice, and both executions really ran", async () => {
    const [result] = await run("status-change", [change("c1"), change("c2"), fauxAssistantMessage("Done: BK1002 is in_transit.")]);

    expect(statusOf(result!, "duplicate-effects")).toBe("fail");
    expect(result!.checks.find((c) => c.name === "duplicate-effects")?.detail).toContain("2 executions");
    const tools = findByName(result!.spans, "lab.tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((span) => span.attributes["lab.tool.replay"])).toEqual(["unsafe", "unsafe"]);
    expect(tools.every((span) => span.attributes["lab.tool.outcome"] === "result" && span.attributes["lab.tool.is_error"] === false)).toBe(true);
  });

  it("passes duplicate-effects for exactly one change, and each repetition starts from a fresh fixture", async () => {
    const results = await run(
      "status-change",
      [change("c1"), fauxAssistantMessage("Done."), change("c2"), fauxAssistantMessage("Done.")],
      2,
    );
    expect(results.map((result) => statusOf(result, "duplicate-effects"))).toEqual(["pass", "pass"]);
    // If repetition 1 had inherited repetition 0's mutation, its tool result would report previousStatus in_transit.
    for (const result of results) {
      expect(JSON.parse(result.toolCalls[0]!.resultText)).toMatchObject({ previousStatus: "booked", newStatus: "in_transit" });
    }
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(2);
  });

  it("fails an expected span kind that is missing — here, a lab.tool span for a case that required one", async () => {
    const [result] = await run("compare-two", [lookup("BK1001"), fauxAssistantMessage("BK1001 goes to NLRTM.")]);
    expect(statusOf(result!, "required-tool-evidence")).toBe("fail"); // BK1003 was never looked up
    expect(findByName(result!.spans, "lab.tool")).toHaveLength(1);
  });
});

describe("runFrozenCases — multi-container bookings", () => {
  it("passes container-coverage and provenance when the answer names both containers of BK1001", async () => {
    const [result] = await run("list-containers", [lookup("BK1001"), fauxAssistantMessage("BK1001 carries MSKU1234567 and MSKU2345678.")]);
    expect(statusOf(result!, "container-coverage")).toBe("pass");
    expect(statusOf(result!, "identifier-provenance")).toBe("pass");
  });

  it("fails container-coverage when the answer describes a two-container booking by one container, even after a real lookup", async () => {
    const [result] = await run("list-containers", [lookup("BK1001"), fauxAssistantMessage("BK1001 has container MSKU1234567.")]);
    expect(statusOf(result!, "required-tool-evidence")).toBe("pass");
    expect(statusOf(result!, "identifier-provenance")).toBe("pass"); // what it named is real...
    expect(statusOf(result!, "container-coverage")).toBe("fail"); // ...but it is not all of it
  });

  it("fails identifier-provenance for a container named without ever looking the booking up", async () => {
    const [result] = await run("list-containers", [fauxAssistantMessage("BK1001 carries MSKU1234567 and MSKU2345678.")]);
    expect(statusOf(result!, "identifier-provenance")).toBe("fail");
    expect(statusOf(result!, "required-tool-evidence")).toBe("fail");
  });

  it("fails identifier-provenance for an invented container number", async () => {
    const [result] = await run("list-containers", [lookup("BK1001"), fauxAssistantMessage("BK1001 carries MSKU1234567, MSKU2345678 and MSKU9999999.")]);
    expect(statusOf(result!, "identifier-provenance")).toBe("fail");
    expect(result!.checks.find((c) => c.name === "identifier-provenance")?.detail).toContain("MSKU9999999");
  });
});

describe("runFrozenCases — errors", () => {
  it("records an unknown booking as an errored tool span and still reaches a second turn", async () => {
    const [result] = await run("unknown-booking", [lookup("BK9999"), fauxAssistantMessage("No booking found for BK9999.")]);

    const tool = findByName(result!.spans, "lab.tool")[0]!;
    expect(tool.attributes).toMatchObject({ "lab.tool.outcome": "result", "lab.tool.is_error": true });
    expect(tool.status).toEqual({ status: "error" });
    expect(result!.toolCalls[0]!.isError).toBe(true);
    expect(statusOf(result!, "identifier-provenance")).toBe("pass"); // BK9999 is echoed from the prompt
    expect(statusOf(result!, "terminal-operation-status")).toBe("pass");
    expect(findByName(result!.spans, "lab.turn")).toHaveLength(2);
  });

  // Probed on this stack: both calls below make the harness commit an error tool result and emit
  // `tool_execution_end` with no `tool_execution_start`. A live model writing one wrong enum value must not
  // be mistaken for a telemetry fault — the demo asserts there are no bridge warnings.
  it.each([
    ["an argument that fails validation", fauxToolCall("update_booking_status", { bookingNo: "BK1002", newStatus: "in transit" }, { id: "c1" }), "update_booking_status"],
    ["a tool that is not offered", fauxToolCall("delete_everything", { everything: true }, { id: "c1" }), "delete_everything"],
  ])("records a refused call (%s) as a refused tool span, with no warning and no executed effect", async (_label, call, toolName) => {
    const [result] = await run("status-change", [
      fauxAssistantMessage(call, { stopReason: "toolUse" }),
      fauxAssistantMessage("I could not make that change."),
    ]);

    expect(result!.operationStatus).toBe("done");
    expect(result!.telemetryWarnings).toEqual([]);
    const tools = findByName(result!.spans, "lab.tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.attributes).toMatchObject({ "lab.tool.name": toolName, "lab.tool.outcome": "refused", "lab.tool.is_error": true });
    expect(tools[0]!.status).toEqual({ status: "error" });
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]).toMatchObject({ toolName, isError: true });
    // The refusal is not an effect: the case expected one change and got none.
    expect(statusOf(result!, "duplicate-effects")).toBe("fail");
    expect(result!.checks.find((c) => c.name === "duplicate-effects")?.detail).toContain("0 executions");
  });

  it("reports a provider failure as an unanswered submission and an error request span", async () => {
    const [result] = await run("lookup-single", [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })]);

    expect(result!.operationStatus).toMatch(/^unanswered/);
    expect(statusOf(result!, "terminal-operation-status")).toBe("fail");
    const request = findByName(result!.spans, "lab.ai.request")[0]!;
    expect(request.status).toEqual({ status: "error" });
    expect(request.attributes).toMatchObject({ "lab.ai.stop_reason": "error", "lab.ai.error_message": "401 invalid api key" });
    expect(result!.answerText).toBe("");
  });
});
