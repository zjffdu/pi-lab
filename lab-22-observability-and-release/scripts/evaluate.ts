import { loadCases } from "../src/case-registry.js";
import { deterministicRubricJudge } from "../src/judge.js";
import { computeMetrics } from "../src/metrics.js";
import { runCases } from "../src/runner.js";

/**
 * The deterministic evaluation report: dev and held-out are run and printed separately so a
 * learner never mistakes a dev-set number for a release-relevant one. Uses only the deterministic
 * rubric judge; `npm run evaluate:live` is the separate, bounded, model-backed layer.
 */
for (const split of ["dev", "held-out"] as const) {
  const cases = loadCases(split);
  const outputs = runCases(cases);
  const records = outputs.map((output) => output.record);
  const metrics = computeMetrics(records);

  console.log(`\n=== ${split} (${cases.length} case(s)) ===`);
  for (const kase of cases) {
    const output = outputs.find((entry) => entry.record.result.caseId === kase.id);
    if (!output) continue;
    const judged = deterministicRubricJudge(kase, output.record.result);
    const invariantsOk = output.record.invariantResults.every((entry) => entry.holds);
    console.log(`  ${kase.id}: outcome=${output.record.result.outcome} invariants=${invariantsOk ? "ok" : "FAILED"} semantic=${judged.score}/${judged.maxScore}`);
  }
  console.log(`  metrics: ${JSON.stringify(metrics, null, 2).replace(/\n/g, "\n  ")}`);
}

console.log("\nSample sizes above are small (learning-lab fixtures), not a statistical production-reliability claim.");
