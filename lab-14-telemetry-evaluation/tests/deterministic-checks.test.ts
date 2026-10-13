import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";

import {
  containerCoverage,
  duplicateEffects,
  identifierProvenance,
  requiredToolEvidence,
  runDeterministicChecks,
  spanCoverageChecks,
  terminalOperationStatus,
  tokenUsageAndLatency,
  unsupportedCausalClaims,
  type CaseRunEvidence,
  type ToolCallRecord,
  UNOBSERVABLE,
} from "../src/deterministic-checks.js";
import { FROZEN_EVALUATION_CASES, type EvaluationCase } from "../src/evaluation-cases.js";

/**
 * Deterministic, network-free proof that each check catches the exact failure the roadmap's failure
 * injections name — "Remove one required tool result", "Produce a duplicated local effect", "Remove one
 * expected telemetry span and report it as unavailable rather than zero" — built from synthetic evidence.
 * `evaluation-runner.test.ts` proves the same failures on real `Harness` runs with a scripted model.
 */

function caseById(id: string): EvaluationCase {
  const found = FROZEN_EVALUATION_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no such case: ${id}`);
  return found;
}

function span(overrides: Partial<RecordedTelemetrySpan> & { name: string }): RecordedTelemetrySpan {
  return { id: 1, parentId: null, attributes: {}, events: [], status: { status: "ok" }, settled: true, ...overrides };
}

function call(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, "toolName" | "args">): ToolCallRecord {
  return { toolCallId: "c1", isError: false, resultText: "", ...overrides };
}

const BK1001_RESULT = JSON.stringify({ bookingNo: "BK1001", containerNos: ["MSKU1234567", "MSKU2345678"], status: "booked" });
const lookup = (bookingNo = "BK1001", resultText = BK1001_RESULT) =>
  call({ toolName: "get_booking", args: { bookingNo }, resultText });

function evidence(overrides: Partial<CaseRunEvidence> = {}): CaseRunEvidence {
  return { answerText: "", operationStatus: "done", toolCalls: [], spans: [], ...overrides };
}

describe("requiredToolEvidence", () => {
  it("fails when a required get_booking call never happened (the roadmap's own failure injection)", () => {
    expect(requiredToolEvidence(caseById("lookup-single"), evidence()).status).toBe("fail");
  });

  it("passes when the required booking was successfully queried", () => {
    expect(requiredToolEvidence(caseById("lookup-single"), evidence({ toolCalls: [lookup()] })).status).toBe("pass");
  });

  it("does not count an errored get_booking call as evidence", () => {
    expect(requiredToolEvidence(caseById("lookup-single"), evidence({ toolCalls: [{ ...lookup(), isError: true }] })).status).toBe("fail");
  });

  it("is skipped for a case that declares no required evidence", () => {
    expect(requiredToolEvidence(caseById("status-change"), evidence()).status).toBe("skipped");
  });
});

describe("identifierProvenance — booking numbers", () => {
  it("fails when the answer names a booking number outside the case's scope (an invented identifier)", () => {
    const result = identifierProvenance(caseById("lookup-single"), evidence({ answerText: "BK1001 is on its way, similar to BK9999." }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("BK9999");
  });

  it("passes when the answer only names allowed bookings", () => {
    expect(identifierProvenance(caseById("compare-two"), evidence({ answerText: "BK1001 goes to NLRTM; BK1003 to USNYC." })).status).toBe("pass");
  });

  it("passes when the answer names nothing", () => {
    expect(identifierProvenance(caseById("lookup-single"), evidence({ answerText: "I could not find that booking." })).status).toBe("pass");
  });
});

describe("identifierProvenance — container numbers", () => {
  it("passes when every named container appears in a successful tool result of this run", () => {
    const result = identifierProvenance(
      caseById("list-containers"),
      evidence({ answerText: "BK1001 carries MSKU1234567 and MSKU2345678.", toolCalls: [lookup()] }),
    );
    expect(result.status).toBe("pass");
  });

  it("fails a container no tool result of this run contains — recalled from memory, never looked up", () => {
    const result = identifierProvenance(caseById("list-containers"), evidence({ answerText: "BK1001 carries MSKU1234567." }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("MSKU1234567");
  });

  it("fails a container leaked from another booking's result", () => {
    const other = lookup("BK1002", JSON.stringify({ bookingNo: "BK1002", containerNos: ["MSKU7654321"] }));
    const result = identifierProvenance(
      caseById("lookup-single"),
      evidence({ answerText: "BK1001 is booked; it has MSKU7654321.", toolCalls: [lookup(), other] }),
    );
    expect(result.status).toBe("pass"); // MSKU7654321 IS in a result of this run...
    const noOther = identifierProvenance(caseById("lookup-single"), evidence({ answerText: "BK1001 is booked; it has MSKU7654321.", toolCalls: [lookup()] }));
    expect(noOther.status).toBe("fail"); // ...and is not once that result is absent.
  });

  it("does not count a container that only appears in an errored tool result", () => {
    const errored = { ...lookup(), isError: true };
    expect(identifierProvenance(caseById("list-containers"), evidence({ answerText: "MSKU1234567", toolCalls: [errored] })).status).toBe("fail");
  });
});

describe("containerCoverage", () => {
  it("is skipped for a case that does not ask for containers", () => {
    expect(containerCoverage(caseById("lookup-single"), evidence({ answerText: "MSKU1234567" })).status).toBe("skipped");
  });

  it("fails when a two-container booking is described by one container — the multi-container failure", () => {
    const result = containerCoverage(caseById("list-containers"), evidence({ answerText: "BK1001 has container MSKU1234567." }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("MSKU2345678");
  });

  it("passes when every container is named", () => {
    expect(containerCoverage(caseById("list-containers"), evidence({ answerText: "MSKU1234567 and MSKU2345678." })).status).toBe("pass");
  });
});

describe("unsupportedCausalClaims", () => {
  it("is skipped for a case that does not invite a causal answer", () => {
    expect(unsupportedCausalClaims(caseById("lookup-single"), evidence({ answerText: "Delayed because of weather." })).status).toBe("skipped");
  });

  it("fails when a causal-inviting case's answer uses causal-connective language the fixture cannot ground", () => {
    expect(unsupportedCausalClaims(caseById("why-delivered"), evidence({ answerText: "Delivered because the vessel arrived early." })).status).toBe("fail");
  });

  it("passes when the answer states the fact without causal language", () => {
    expect(unsupportedCausalClaims(caseById("why-delivered"), evidence({ answerText: "BK1003's status is delivered." })).status).toBe("pass");
  });
});

describe("terminalOperationStatus", () => {
  it("passes for a done submission", () => {
    expect(terminalOperationStatus(evidence({ operationStatus: "done" })).status).toBe("pass");
  });

  it("fails for an unanswered submission, naming the reason", () => {
    const result = terminalOperationStatus(evidence({ operationStatus: "unanswered:provider_error" }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("unanswered:provider_error");
  });
});

describe("duplicateEffects", () => {
  const change = (id: string, isError = false) =>
    call({ toolName: "update_booking_status", toolCallId: id, args: { bookingNo: "BK1002", newStatus: "in_transit" }, isError });

  it("fails when an expected effect never executed", () => {
    const result = duplicateEffects(caseById("status-change"), evidence());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("0 executions");
  });

  it("fails when an expected effect executed twice — the roadmap's 'duplicated local effect' injection", () => {
    const result = duplicateEffects(caseById("status-change"), evidence({ toolCalls: [change("c1"), change("c2")] }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("duplicate effect");
  });

  it("passes when the expected effect executed exactly once", () => {
    expect(duplicateEffects(caseById("status-change"), evidence({ toolCalls: [change("c1")] })).status).toBe("pass");
  });

  it("does not count an errored attempt as an execution", () => {
    expect(duplicateEffects(caseById("status-change"), evidence({ toolCalls: [change("c1", true), change("c2")] })).status).toBe("pass");
  });

  it("fails when a case expecting no effects gets an unintended one", () => {
    const unintended = call({ toolName: "update_booking_status", args: { bookingNo: "BK1001", newStatus: "cancelled" } });
    expect(duplicateEffects(caseById("lookup-single"), evidence({ toolCalls: [unintended] })).status).toBe("fail");
  });
});

describe("tokenUsageAndLatency", () => {
  const request = (id: number, attributes: RecordedTelemetrySpan["attributes"]) => span({ name: "lab.ai.request", id, attributes });

  it("reports both unavailable (not zero) when no lab.ai.request span exists", () => {
    const [tokens, latency] = tokenUsageAndLatency(evidence());
    expect(tokens.status).toBe("unavailable");
    expect(latency.status).toBe("unavailable");
  });

  it("reports token usage pass, summed across request spans", () => {
    const [tokens] = tokenUsageAndLatency(
      evidence({ spans: [request(1, { "lab.ai.usage.total_tokens": 42 }), request(2, { "lab.ai.usage.total_tokens": 8 })] }),
    );
    expect(tokens.status).toBe("pass");
    expect(tokens.detail).toContain("50");
  });

  it("reports latency pass from the providers' own durationMs when EVERY request carries one", () => {
    const [, latency] = tokenUsageAndLatency(
      evidence({ spans: [request(1, { "lab.ai.duration_ms": 100.4 }), request(2, { "lab.ai.duration_ms": 200.4 })] }),
    );
    expect(latency.status).toBe("pass");
    expect(latency.detail).toContain("301ms");
  });

  // A partial sum is a latency nobody measured. This is the "unavailable, not zero" rule applied to a number.
  it("reports latency unavailable — not a partial sum — when only some requests carry a durationMs", () => {
    const [, latency] = tokenUsageAndLatency(evidence({ spans: [request(1, { "lab.ai.duration_ms": 100 }), request(2, {})] }));
    expect(latency.status).toBe("unavailable");
    expect(latency.detail).toContain("1 of 2");
  });

  it("reports latency unavailable when no request carries a durationMs (legacy or deferred results)", () => {
    const [, latency] = tokenUsageAndLatency(evidence({ spans: [request(1, {})] }));
    expect(latency.status).toBe("unavailable");
  });
});

describe("spanCoverageChecks", () => {
  it("fails an expected span kind that never appeared — the roadmap's 'remove one expected span' injection", () => {
    const results = spanCoverageChecks(evidence(), ["lab.run", "lab.tool"]);
    expect(results.find((r) => r.name === "span:lab.run")?.status).toBe("fail");
    expect(results.find((r) => r.name === "span:lab.tool")?.status).toBe("fail");
  });

  it("passes an expected span kind that is present", () => {
    expect(spanCoverageChecks(evidence({ spans: [span({ name: "lab.run" })] }), ["lab.run"]).find((r) => r.name === "span:lab.run")?.status).toBe("pass");
  });

  it("always reports what the 1.1 stream cannot show (navigation, recovery) as unavailable, never fail", () => {
    const results = spanCoverageChecks(evidence(), []);
    expect(UNOBSERVABLE.map((entry) => entry.name)).toEqual(["navigation", "recovery"]);
    for (const { name } of UNOBSERVABLE) {
      expect(results.find((r) => r.name === `unobservable:${name}`)?.status).toBe("unavailable");
    }
  });
});

describe("runDeterministicChecks", () => {
  it("returns one result per check for a fully satisfied case", () => {
    const results = runDeterministicChecks(
      caseById("lookup-single"),
      evidence({ answerText: "BK1001 is booked, headed to NLRTM.", toolCalls: [lookup()], spans: [span({ name: "lab.run" })] }),
      ["lab.run"],
    );
    const byName = new Map(results.map((r) => [r.name, r.status]));
    expect(byName.get("required-tool-evidence")).toBe("pass");
    expect(byName.get("identifier-provenance")).toBe("pass");
    expect(byName.get("container-coverage")).toBe("skipped");
    expect(byName.get("terminal-operation-status")).toBe("pass");
    expect(byName.get("duplicate-effects")).toBe("pass");
  });
});
