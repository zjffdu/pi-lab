import type { CaseFixture } from "./case-registry.js";
import type { RunResult } from "./pipeline.js";

export interface JudgeScore {
  score: number;
  maxScore: number;
  notes: string;
}

export type Judge = (kase: CaseFixture, result: RunResult) => JudgeScore;

/**
 * Stands in for the roadmap's "human rubric for semantic quality" so the deterministic path
 * (`npm run evaluate`, `npm run check`) never calls a model. It is deliberately mechanical: it
 * checks the answer text against each case's declared `mustMention`/`mustNotMention` terms and
 * nothing else. `calibration.ts` measures how well this stand-in agrees with real human labels on
 * a small sample — the point of that exercise is to find where the two disagree, not to assume
 * they do not. A case without a `semantic` block is scored 1/1 (not applicable, not "unavailable"
 * — that distinction matters for `evidence.ts`, which this module has no part in).
 */
export const deterministicRubricJudge: Judge = (kase, result) => {
  if (!kase.semantic) return { score: 1, maxScore: 1, notes: "no semantic rubric declared for this case" };
  const { mustMention = [], mustNotMention = [] } = kase.semantic;
  const answer = result.answer.toLowerCase();
  const mentionHits = mustMention.filter((term) => answer.includes(term.toLowerCase()));
  const forbiddenHits = mustNotMention.filter((term) => answer.includes(term.toLowerCase()));
  const maxScore = mustMention.length + mustNotMention.length || 1;
  const score = mentionHits.length + (mustNotMention.length - forbiddenHits.length);
  return {
    score,
    maxScore,
    notes: `mentioned ${mentionHits.length}/${mustMention.length} required term(s); avoided ${mustNotMention.length - forbiddenHits.length}/${mustNotMention.length} forbidden term(s)`,
  };
};
