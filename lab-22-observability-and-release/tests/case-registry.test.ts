import { describe, expect, it } from "vitest";

import { loadAllCases, loadCases, SCENARIO_IDS } from "../src/case-registry.js";

describe("case-registry", () => {
  it("loads every dev and held-out fixture and stamps the right split", () => {
    for (const split of ["dev", "held-out"] as const) {
      const cases = loadCases(split);
      expect(cases.length).toBeGreaterThan(0);
      for (const kase of cases) expect(kase.split).toBe(split);
    }
  });

  it("covers every declared scenario at least once across both splits", () => {
    const cases = loadAllCases();
    const covered = new Set(cases.map((kase) => kase.scenario));
    for (const scenario of SCENARIO_IDS) expect(covered.has(scenario)).toBe(true);
  });

  it("gives every case a unique id", () => {
    const ids = loadAllCases().map((kase) => kase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
