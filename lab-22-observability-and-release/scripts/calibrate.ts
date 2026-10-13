import { loadAllCases } from "../src/case-registry.js";
import { calibrateJudge, loadHumanLabels } from "../src/calibration.js";
import { deterministicRubricJudge } from "../src/judge.js";
import { runCases } from "../src/runner.js";

const cases = loadAllCases();
const labels = loadHumanLabels();
const labeledCases = cases.filter((kase) => labels.some((label) => label.caseId === kase.id));
const results = runCases(labeledCases).map((output) => output.record.result);

const report = calibrateJudge(deterministicRubricJudge, labels, cases, results);

console.log(`[calibrate] ${report.sampleSize} labeled case(s), agreement rate ${report.agreementRate.toFixed(2)}, mean |diff| ${report.meanAbsoluteDifference.toFixed(3)}`);
for (const row of report.rows) {
  console.log(`  ${row.agrees ? "agree   " : "DISAGREE"}  ${row.caseId}  judge=${row.judgeFraction.toFixed(2)} human=${row.humanFraction.toFixed(2)} |diff|=${row.absoluteDifference.toFixed(2)}`);
}
if (report.disagreements.length > 0) {
  console.log(`\n${report.disagreements.length} disagreement(s) — the labeled notes in judge/labels.json explain the reviewer's reasoning for each.`);
}
console.log("\nThis calibration sample is small; treat the agreement rate as a starting estimate to grow, not a settled number.");
