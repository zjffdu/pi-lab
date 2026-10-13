import type { RunResult } from "./pipeline.js";
import type { InvariantResult } from "./invariants.js";

export interface CaseOutcomeRecord {
  result: RunResult;
  expectedOutcome: string;
  invariantResults: InvariantResult[];
}

/**
 * Latency, cost, and status are reported as **separate** figures on purpose (scope item: "Report
 * availability, task success, authorization violations, and manual intervention as separate
 * metrics"). Blending them into one pass rate would hide, for example, a run that is fast and
 * "available" but authorized the wrong tenant.
 */
export interface MetricsReport {
  sampleSize: number;
  latency: { wallClockMsP50: number; wallClockMsP95: number; toolLatencyMsP50: number };
  cost: { tokenCount: number | null; costUsd: number | null };
  status: {
    availability: number;
    taskSuccess: number;
    authorizationViolationRate: number;
    manualInterventionRate: number;
  };
  terminalStatusCounts: Record<string, number>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const AUTHORIZATION_INVARIANT_IDS = new Set(["no-cross-tenant-leak", "stale-permission-blocked", "approval-required-before-effect"]);

export function computeMetrics(records: readonly CaseOutcomeRecord[]): MetricsReport {
  const sampleSize = records.length;
  const wallClockMs = records.map(({ result }) => new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime());
  const toolLatencyMs = records.map(({ result }) => result.spans.filter((span) => span.stage === "tool").reduce((sum, span) => sum + span.durationMs, 0));

  const terminalStatusCounts: Record<string, number> = {};
  for (const { result } of records) terminalStatusCounts[result.outcome] = (terminalStatusCounts[result.outcome] ?? 0) + 1;

  const availableCount = records.filter(({ result }) => result.outcome !== "error" && result.outcome !== "interrupted").length;
  const successCount = records.filter(({ result, expectedOutcome }) => result.outcome === expectedOutcome).length;
  const authorizationViolationCount = records.filter(({ invariantResults }) => invariantResults.some((entry) => AUTHORIZATION_INVARIANT_IDS.has(entry.id) && !entry.holds)).length;
  const manualInterventionCount = records.filter(({ result }) => result.outcome === "manual_review").length;

  return {
    sampleSize,
    latency: {
      wallClockMsP50: percentile(wallClockMs, 50),
      wallClockMsP95: percentile(wallClockMs, 95),
      toolLatencyMsP50: percentile(toolLatencyMs, 50),
    },
    // No live model runs in the deterministic path, so token/cost are reported as unavailable
    // rather than silently defaulted to zero. `evaluate-live.ts` fills these in for a live run.
    cost: { tokenCount: null, costUsd: null },
    status: {
      availability: sampleSize === 0 ? 0 : availableCount / sampleSize,
      taskSuccess: sampleSize === 0 ? 0 : successCount / sampleSize,
      authorizationViolationRate: sampleSize === 0 ? 0 : authorizationViolationCount / sampleSize,
      manualInterventionRate: sampleSize === 0 ? 0 : manualInterventionCount / sampleSize,
    },
    terminalStatusCounts,
  };
}
