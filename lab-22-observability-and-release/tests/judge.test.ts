import { describe, expect, it } from "vitest";

import type { CaseFixture } from "../src/case-registry.js";
import { deterministicRubricJudge } from "../src/judge.js";
import type { RunResult } from "../src/pipeline.js";

function kase(overrides: Partial<CaseFixture> = {}): CaseFixture {
  return {
    id: "k1",
    split: "dev",
    scenario: "read-own-tenant",
    description: "test",
    tenantId: "tenant-a",
    subject: "alice",
    bookingNo: "BK1001",
    expected: { outcome: "answered", reachedStages: [], invariants: [] },
    ...overrides,
  };
}

function result(answer: string): RunResult {
  return { runId: "r", caseId: "k1", outcome: "answered", answer, startedAt: "", endedAt: "", spans: [] };
}

describe("deterministicRubricJudge", () => {
  it("scores 1/1 when a case declares no semantic rubric", () => {
    expect(deterministicRubricJudge(kase(), result("anything"))).toEqual({ score: 1, maxScore: 1, notes: "no semantic rubric declared for this case" });
  });

  it("gives full credit when every required term is present and no forbidden term is", () => {
    const judged = deterministicRubricJudge(kase({ semantic: { rubric: "r", mustMention: ["booked"], mustNotMention: ["denied"] } }), result("BK1001 is booked."));
    expect(judged.score).toBe(judged.maxScore);
  });

  it("loses credit for a missing required term and for a present forbidden term", () => {
    const judged = deterministicRubricJudge(kase({ semantic: { rubric: "r", mustMention: ["booked"], mustNotMention: ["denied"] } }), result("Access denied."));
    // mustMention miss (0/1) + mustNotMention hit (0/1 avoided) = 0, out of maxScore 2
    expect(judged).toEqual({ score: 0, maxScore: 2, notes: "mentioned 0/1 required term(s); avoided 0/1 forbidden term(s)" });
  });
});
