import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkReadiness, InvalidConfigError, loadThresholds, validateThresholds } from "../src/config.js";

describe("validateThresholds", () => {
  it("accepts a well-formed thresholds object", () => {
    const thresholds = validateThresholds({ minTaskSuccessRate: 0.8, maxAuthorizationViolationRate: 0, minSemanticScoreFraction: 0.5, minJudgeAgreementRate: 0.5, maxWallClockMsP95: 5000 });
    expect(thresholds.minTaskSuccessRate).toBe(0.8);
  });

  it("rejects a missing field rather than defaulting it (the invalid-configuration injection)", () => {
    expect(() => validateThresholds({ maxAuthorizationViolationRate: 0, minSemanticScoreFraction: 0.5, minJudgeAgreementRate: 0.5, maxWallClockMsP95: 5000 })).toThrow(InvalidConfigError);
  });

  it("rejects a fraction field out of [0, 1]", () => {
    expect(() => validateThresholds({ minTaskSuccessRate: 1.5, maxAuthorizationViolationRate: 0, minSemanticScoreFraction: 0.5, minJudgeAgreementRate: 0.5, maxWallClockMsP95: 5000 })).toThrow(InvalidConfigError);
  });

  it("rejects a negative latency threshold", () => {
    expect(() => validateThresholds({ minTaskSuccessRate: 0.8, maxAuthorizationViolationRate: 0, minSemanticScoreFraction: 0.5, minJudgeAgreementRate: 0.5, maxWallClockMsP95: -1 })).toThrow(InvalidConfigError);
  });

  it("rejects a non-object value", () => {
    expect(() => validateThresholds(null)).toThrow(InvalidConfigError);
    expect(() => validateThresholds("nope")).toThrow(InvalidConfigError);
  });
});

describe("loadThresholds", () => {
  it("loads the committed config/release-thresholds.json", () => {
    expect(() => loadThresholds()).not.toThrow();
  });

  it("throws InvalidConfigError, not a generic parse error, when pointed at a broken config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-badconfig-"));
    const path = join(dir, "broken.json");
    writeFileSync(path, JSON.stringify({ minTaskSuccessRate: "not-a-number" }), "utf8");
    expect(() => loadThresholds(path)).toThrow(InvalidConfigError);
  });
});

describe("checkReadiness", () => {
  it("is ready when every input is valid and the evidence directory is writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-evidence-"));
    const readiness = checkReadiness(dir);
    expect(readiness).toEqual({ ready: true, reasons: [] });
  });
});
