import { describe, expect, it } from "vitest";

import { checkEvidence } from "../src/evidence.js";
import { loadCases } from "../src/case-registry.js";
import { runCase } from "../src/runner.js";

describe("checkEvidence", () => {
  it("holds when every expected stage has a span", () => {
    const [kase] = loadCases("dev");
    if (!kase) throw new Error("expected at least one dev case");
    const { record } = runCase(kase);
    const check = checkEvidence(kase, record.result);
    expect(check.holds).toBe(true);
    expect(check.missingStages).toEqual([]);
  });

  it("reports missing_evidence when the dropStageSpan simulation drops an expected stage's span (the missing-span injection)", () => {
    const cases = loadCases("dev");
    const kase = cases.find((entry) => entry.scenario === "propose-without-approval");
    if (!kase) throw new Error("expected a propose-without-approval dev case");
    const poisoned = { ...kase, simulate: { ...kase.simulate, dropStageSpan: "approval" as const } };
    const { record } = runCase(poisoned);
    // The outcome and invariants are unaffected — only the telemetry for the approval stage is missing.
    expect(record.result.outcome).toBe(kase.expected.outcome);
    const check = checkEvidence(kase, record.result);
    expect(check.holds).toBe(false);
    expect(check.missingStages).toEqual(["approval"]);
  });

  it("does not flag a stage the case never expected to reach", () => {
    const cases = loadCases("dev");
    const kase = cases.find((entry) => entry.scenario === "read-own-tenant");
    if (!kase) throw new Error("expected a read-own-tenant dev case");
    const { record } = runCase(kase);
    expect(record.result.spans.some((span) => span.stage === "approval")).toBe(false);
    expect(checkEvidence(kase, record.result).holds).toBe(true);
  });
});
