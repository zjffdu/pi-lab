import { describe, expect, it } from "vitest";

import { computeMetrics, type CaseOutcomeRecord } from "../src/metrics.js";
import type { RunResult } from "../src/pipeline.js";

function record(overrides: Partial<RunResult>, expectedOutcome: string, invariantHolds = true): CaseOutcomeRecord {
  const result: RunResult = { runId: "r", caseId: "c", outcome: "answered", answer: "", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.010Z", spans: [], ...overrides };
  return { result, expectedOutcome, invariantResults: [{ id: "x", critical: true, holds: invariantHolds, detail: "" }] };
}

describe("computeMetrics", () => {
  it("reports availability, task success, authorization violations, and manual intervention as separate figures", () => {
    const records: CaseOutcomeRecord[] = [
      record({ outcome: "answered" }, "answered", true),
      record({ outcome: "denied" }, "answered", false), // wrong outcome -> task failure, but not authorization-tagged here
      record({ outcome: "error" }, "answered", true), // unavailable
      record({ outcome: "manual_review" }, "manual_review", true),
    ];
    const report = computeMetrics(records);
    expect(report.sampleSize).toBe(4);
    expect(report.status.availability).toBe(3 / 4);
    expect(report.status.taskSuccess).toBe(2 / 4);
    expect(report.status.manualInterventionRate).toBe(1 / 4);
    expect(report.terminalStatusCounts).toEqual({ answered: 1, denied: 1, error: 1, manual_review: 1 });
  });

  it("tags an authorization-invariant failure as an authorization violation, distinct from any other invariant failure", () => {
    const authFailure: CaseOutcomeRecord = { result: { runId: "r", caseId: "c", outcome: "answered", answer: "", startedAt: "", endedAt: "", spans: [] }, expectedOutcome: "answered", invariantResults: [{ id: "no-cross-tenant-leak", critical: true, holds: false, detail: "" }] };
    const otherFailure: CaseOutcomeRecord = { result: { runId: "r", caseId: "c2", outcome: "answered", answer: "", startedAt: "", endedAt: "", spans: [] }, expectedOutcome: "answered", invariantResults: [{ id: "no-invented-identifiers", critical: false, holds: false, detail: "" }] };
    const report = computeMetrics([authFailure, otherFailure]);
    expect(report.status.authorizationViolationRate).toBe(0.5);
  });

  it("reports token/cost as unavailable (null), never a silently-defaulted zero", () => {
    const report = computeMetrics([]);
    expect(report.cost).toEqual({ tokenCount: null, costUsd: null });
    expect(report.sampleSize).toBe(0);
  });
});
