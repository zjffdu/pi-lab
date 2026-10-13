import { describe, expect, it } from "vitest";

import { aggregateChecks, buildReport } from "../src/report.js";
import type { CaseRunResult } from "../src/evaluation-runner.js";

function result(overrides: Partial<CaseRunResult> = {}): CaseRunResult {
  return {
    caseId: "lookup-single",
    repetition: 0,
    sessionId: "s1",
    prompt: "p",
    answerText: "a",
    operationStatus: "completed",
    wallClockMs: 100,
    checks: [{ name: "required-tool-evidence", status: "pass", detail: "" }],
    spans: [],
    toolCalls: [],
    telemetryWarnings: [],
    ...overrides,
  };
}

describe("aggregateChecks", () => {
  it("counts each status per check name across all results", () => {
    const results = [
      result({ checks: [{ name: "a", status: "pass", detail: "" }] }),
      result({ checks: [{ name: "a", status: "fail", detail: "" }] }),
      result({ checks: [{ name: "a", status: "pass", detail: "" }] }),
      result({ checks: [{ name: "b", status: "unavailable", detail: "" }] }),
    ];
    const aggregate = aggregateChecks(results);
    const a = aggregate.find((row) => row.name === "a");
    const b = aggregate.find((row) => row.name === "b");
    expect(a).toEqual({ name: "a", pass: 2, fail: 1, skipped: 0, unavailable: 0, total: 3 });
    expect(b).toEqual({ name: "b", pass: 0, fail: 0, skipped: 0, unavailable: 1, total: 1 });
  });
});

describe("buildReport", () => {
  it("lists only case+repetition rows that had at least one failing check", () => {
    const results = [
      result({ caseId: "a", repetition: 0, checks: [{ name: "x", status: "pass", detail: "" }] }),
      result({ caseId: "b", repetition: 0, checks: [{ name: "x", status: "fail", detail: "" }] }),
    ];
    const report = buildReport(
      { modelProvider: "deepseek", modelId: "deepseek-flash", promptVersion: "v2", caseIds: ["a", "b"], repetitions: 1, startedAt: "now" },
      results,
    );
    expect(report.failures).toEqual([{ caseId: "b", repetition: 0, failedChecks: ["x"] }]);
    expect(report.perCase).toHaveLength(2);
  });
});
