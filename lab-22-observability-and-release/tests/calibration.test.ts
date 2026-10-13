import { describe, expect, it } from "vitest";

import { loadAllCases } from "../src/case-registry.js";
import { calibrateJudge, loadHumanLabels } from "../src/calibration.js";
import { deterministicRubricJudge } from "../src/judge.js";
import { runCases } from "../src/runner.js";

describe("calibrateJudge (against judge/labels.json)", () => {
  it("reproduces the recorded calibration exactly (regression pin — see README for the numbers)", () => {
    const cases = loadAllCases();
    const labels = loadHumanLabels();
    expect(labels.length).toBeGreaterThan(0);
    const labeledCases = cases.filter((kase) => labels.some((label) => label.caseId === kase.id));
    const results = runCases(labeledCases).map((output) => output.record.result);

    const report = calibrateJudge(deterministicRubricJudge, labels, cases, results);
    expect(report.sampleSize).toBe(labels.length);
    expect(report.agreementRate).toBeCloseTo(0.75, 5);
    expect(report.disagreements).toHaveLength(1);
    expect(report.disagreements[0]?.caseId).toBe("held-read-own-tenant-b");
  });

  it("throws when a label references a case that does not exist in the registry", () => {
    const cases = loadAllCases();
    const badLabels = [{ caseId: "does-not-exist", humanScore: 1, humanMaxScore: 1, note: "n/a" }];
    expect(() => calibrateJudge(deterministicRubricJudge, badLabels, cases, [])).toThrow(/unknown case/);
  });
});
