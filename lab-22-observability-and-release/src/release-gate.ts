import type { ReadinessCheck, ReleaseThresholds } from "./config.js";
import type { CalibrationReport } from "./calibration.js";
import { computeMetrics, type CaseOutcomeRecord, type MetricsReport } from "./metrics.js";
import type { EvidenceCheck } from "./evidence.js";
import type { JudgeScore } from "./judge.js";

export type FailureCategory = "infrastructure_failure" | "missing_evidence" | "behavioral_failure" | "semantic_below_threshold";

export interface FailureReason {
  category: FailureCategory;
  /** An authorization, approval, or idempotency violation, or missing required evidence: cannot be waived by loosening a threshold. */
  critical: boolean;
  detail: string;
  caseId?: string;
}

export interface ReleaseDecision {
  pass: boolean;
  reasons: FailureReason[];
  sampleSize: number;
  metrics: MetricsReport | null;
  calibration: CalibrationReport | null;
  thresholds: ReleaseThresholds;
}

export interface ReleaseGateInput {
  readiness: ReadinessCheck;
  heldOutRecords: CaseOutcomeRecord[];
  evidenceChecks: EvidenceCheck[];
  /** Judge score per held-out case id, for the cases that declare a `semantic` rubric. */
  semanticScores: Map<string, JudgeScore>;
  calibration: CalibrationReport;
  thresholds: ReleaseThresholds;
}

/**
 * Combines deterministic invariant results, required-evidence checks, aggregate metrics, and
 * judge-calibration evidence into one PASS/FAIL decision, with every reason tagged by category so
 * an infrastructure problem, a missing observation, a behavioral failure, and a semantic score are
 * never collapsed into one pass rate (acceptance criterion 2). Readiness is checked first: if the
 * gate cannot even start on valid inputs, nothing downstream is evaluated as if it had run.
 */
export function runReleaseGate(input: ReleaseGateInput): ReleaseDecision {
  const { readiness, heldOutRecords, evidenceChecks, semanticScores, calibration, thresholds } = input;

  if (!readiness.ready) {
    return {
      pass: false,
      reasons: readiness.reasons.map((detail) => ({ category: "infrastructure_failure", critical: true, detail })),
      sampleSize: 0,
      metrics: null,
      calibration: null,
      thresholds,
    };
  }

  const reasons: FailureReason[] = [];

  for (const check of evidenceChecks) {
    if (!check.holds) {
      reasons.push({ category: "missing_evidence", critical: true, caseId: check.caseId, detail: `missing required span(s) for stage(s): ${check.missingStages.join(", ")}` });
    }
  }

  for (const record of heldOutRecords) {
    for (const invariant of record.invariantResults) {
      if (!invariant.holds) {
        reasons.push({ category: "behavioral_failure", critical: invariant.critical, caseId: record.result.caseId, detail: `invariant "${invariant.id}" failed: ${invariant.detail}` });
      }
    }
  }

  for (const [caseId, score] of semanticScores) {
    const fraction = score.score / score.maxScore;
    if (fraction < thresholds.minSemanticScoreFraction) {
      reasons.push({ category: "semantic_below_threshold", critical: false, caseId, detail: `semantic score ${fraction.toFixed(2)} below threshold ${thresholds.minSemanticScoreFraction} (${score.notes})` });
    }
  }

  const metrics = computeMetrics(heldOutRecords);
  if (metrics.status.taskSuccess < thresholds.minTaskSuccessRate) {
    reasons.push({ category: "behavioral_failure", critical: false, detail: `task success ${metrics.status.taskSuccess.toFixed(2)} below threshold ${thresholds.minTaskSuccessRate}` });
  }
  if (metrics.status.authorizationViolationRate > thresholds.maxAuthorizationViolationRate) {
    reasons.push({ category: "behavioral_failure", critical: true, detail: `authorization violation rate ${metrics.status.authorizationViolationRate.toFixed(2)} above threshold ${thresholds.maxAuthorizationViolationRate}` });
  }
  if (metrics.latency.wallClockMsP95 > thresholds.maxWallClockMsP95) {
    reasons.push({ category: "behavioral_failure", critical: false, detail: `p95 wall-clock latency ${metrics.latency.wallClockMsP95}ms above threshold ${thresholds.maxWallClockMsP95}ms` });
  }

  if (calibration.agreementRate < thresholds.minJudgeAgreementRate) {
    reasons.push({ category: "semantic_below_threshold", critical: false, detail: `judge/human agreement ${calibration.agreementRate.toFixed(2)} below threshold ${thresholds.minJudgeAgreementRate}; semantic scores are not trustworthy at this calibration` });
  }

  return { pass: reasons.length === 0, reasons, sampleSize: heldOutRecords.length, metrics, calibration, thresholds };
}

/** CLI exit-code convention: 2 on a critical reason, 1 on any other failure, 0 on pass. */
export function exitCodeFor(decision: ReleaseDecision): number {
  if (decision.reasons.some((reason) => reason.critical)) return 2;
  return decision.pass ? 0 : 1;
}
