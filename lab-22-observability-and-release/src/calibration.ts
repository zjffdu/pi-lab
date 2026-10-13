import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CaseFixture } from "./case-registry.js";
import type { Judge } from "./judge.js";
import type { RunResult } from "./pipeline.js";

export interface HumanLabel {
  caseId: string;
  humanScore: number;
  humanMaxScore: number;
  note: string;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

function isHumanLabel(value: unknown): value is HumanLabel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.caseId) && isNumber(candidate.humanScore) && isNumber(candidate.humanMaxScore) && isString(candidate.note);
}

const LABELS_PATH = fileURLToPath(new URL("../judge/labels.json", import.meta.url));

/** Runtime-validated load of the small human-labeled calibration sample — no `as` cast. */
export function loadHumanLabels(): HumanLabel[] {
  const parsed: unknown = JSON.parse(readFileSync(LABELS_PATH, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isHumanLabel)) throw new Error("judge/labels.json is not a valid HumanLabel[]");
  return parsed;
}

export interface CalibrationRow {
  caseId: string;
  judgeFraction: number;
  humanFraction: number;
  absoluteDifference: number;
  agrees: boolean;
}

export interface CalibrationReport {
  sampleSize: number;
  agreementRate: number;
  meanAbsoluteDifference: number;
  disagreements: CalibrationRow[];
  rows: CalibrationRow[];
}

/**
 * `tolerance` is the largest fraction-of-max-score gap still counted as agreement. The default
 * (one rubric term's worth on a typical 2–4 term case) is a judgment call, not a proven
 * threshold — the point of running this against real labels is to find out whether it should be
 * tighter, not to assume 0.34 is correct.
 */
export function calibrateJudge(judge: Judge, labels: readonly HumanLabel[], cases: readonly CaseFixture[], results: readonly RunResult[], tolerance = 0.34): CalibrationReport {
  const casesById = new Map(cases.map((kase) => [kase.id, kase]));
  const resultsById = new Map(results.map((result) => [result.caseId, result]));

  const rows: CalibrationRow[] = labels.map((label) => {
    const kase = casesById.get(label.caseId);
    const result = resultsById.get(label.caseId);
    if (!kase || !result) throw new Error(`judge/labels.json references unknown case "${label.caseId}"`);
    const judged = judge(kase, result);
    const judgeFraction = judged.score / judged.maxScore;
    const humanFraction = label.humanScore / label.humanMaxScore;
    const absoluteDifference = Math.abs(judgeFraction - humanFraction);
    return { caseId: label.caseId, judgeFraction, humanFraction, absoluteDifference, agrees: absoluteDifference <= tolerance };
  });

  const disagreements = rows.filter((row) => !row.agrees);
  const meanAbsoluteDifference = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.absoluteDifference, 0) / rows.length;

  return {
    sampleSize: rows.length,
    agreementRate: rows.length === 0 ? 0 : (rows.length - disagreements.length) / rows.length,
    meanAbsoluteDifference,
    disagreements,
    rows,
  };
}
