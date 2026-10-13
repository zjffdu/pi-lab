import type { CaseFixture } from "./case-registry.js";
import type { RunResult } from "./pipeline.js";
import type { Stage } from "./trace.js";

/**
 * Distinguishes "the run never needed this stage" from "the run needed this stage and nobody
 * recorded it". Only the second is `missing_evidence`. This is what lets `release-gate.ts` tell
 * a genuinely successful read (no approval span, correctly) apart from a case whose telemetry
 * pipeline silently dropped a span the case actually needed (the `missing-span` failure injection).
 */
export interface EvidenceCheck {
  caseId: string;
  missingStages: Stage[];
  holds: boolean;
}

export function checkEvidence(kase: CaseFixture, result: RunResult): EvidenceCheck {
  const presentStages = new Set(result.spans.map((span) => span.stage));
  const missingStages = kase.expected.reachedStages.filter((stage) => !presentStages.has(stage));
  return { caseId: kase.id, missingStages, holds: missingStages.length === 0 };
}
