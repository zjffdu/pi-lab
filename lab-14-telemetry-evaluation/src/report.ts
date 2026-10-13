import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CheckStatus } from "./deterministic-checks.js";
import type { CaseRunResult } from "./evaluation-runner.js";

export interface ComparisonManifest {
  modelProvider: string;
  modelId: string;
  promptVersion: string;
  caseIds: readonly string[];
  repetitions: number;
  startedAt: string;
}

export interface AggregateCheckSummary {
  name: string;
  pass: number;
  fail: number;
  skipped: number;
  unavailable: number;
  total: number;
}

export interface EvaluationReport {
  manifest: ComparisonManifest;
  perCase: CaseRunResult[];
  aggregate: AggregateCheckSummary[];
  /** Every case+repetition where at least one check returned `fail`, listed for quick triage. */
  failures: { caseId: string; repetition: number; failedChecks: string[] }[];
}

export function aggregateChecks(results: readonly CaseRunResult[]): AggregateCheckSummary[] {
  const byName = new Map<string, AggregateCheckSummary>();
  for (const result of results) {
    for (const check of result.checks) {
      const existing = byName.get(check.name) ?? { name: check.name, pass: 0, fail: 0, skipped: 0, unavailable: 0, total: 0 };
      existing[check.status as CheckStatus] += 1;
      existing.total += 1;
      byName.set(check.name, existing);
    }
  }
  return [...byName.values()];
}

export function buildReport(manifest: ComparisonManifest, results: readonly CaseRunResult[]): EvaluationReport {
  const failures = results
    .map((result) => ({
      caseId: result.caseId,
      repetition: result.repetition,
      failedChecks: result.checks.filter((check) => check.status === "fail").map((check) => check.name),
    }))
    .filter((entry) => entry.failedChecks.length > 0);

  return {
    manifest,
    perCase: [...results],
    aggregate: aggregateChecks(results),
    failures,
  };
}

export async function writeReport(path: string, report: EvaluationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

export function printReportSummary(report: EvaluationReport): void {
  console.log(
    `\n[Manifest] model=${report.manifest.modelProvider}/${report.manifest.modelId} ` +
      `promptVersion=${report.manifest.promptVersion} cases=${report.manifest.caseIds.join(",")} ` +
      `repetitions=${report.manifest.repetitions} startedAt=${report.manifest.startedAt}`,
  );
  console.log("\n[Aggregate checks]");
  console.table(report.aggregate.map(({ name, pass, fail, skipped, unavailable, total }) => ({ name, pass, fail, skipped, unavailable, total })));
  if (report.failures.length > 0) {
    console.log("\n[Failures]");
    console.table(report.failures);
  } else {
    console.log("\n[Failures] none");
  }
}
