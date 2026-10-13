import { loadCases, type Split } from "../src/case-registry.js";
import { runCase } from "../src/runner.js";

const split = process.argv[2];
if (split !== "dev" && split !== "held-out") {
  console.error('Usage: npm run run:dev | npm run run:held-out   (or: node --import tsx scripts/run-cases.ts <dev|held-out>)');
  process.exit(2);
}

const cases = loadCases(split as Split);
console.log(`[run-cases] ${cases.length} case(s) in split "${split}"\n`);

let failures = 0;
for (const kase of cases) {
  const { record, evidence } = runCase(kase, { traceDir: "runtime-evidence/traces" });
  const outcomeOk = record.result.outcome === record.expectedOutcome;
  const invariantsOk = record.invariantResults.every((entry) => entry.holds);
  const ok = outcomeOk && invariantsOk && evidence.holds;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${kase.id}`);
  console.log(`      outcome: ${record.result.outcome} (expected ${record.expectedOutcome})`);
  console.log(`      answer:  ${record.result.answer}`);
  if (!evidence.holds) console.log(`      MISSING EVIDENCE: ${evidence.missingStages.join(", ")}`);
  for (const invariant of record.invariantResults) {
    if (!invariant.holds) console.log(`      INVARIANT FAILED (${invariant.critical ? "critical" : "non-critical"}) ${invariant.id}: ${invariant.detail}`);
  }
  console.log(`      trace:   npm run trace -- ${kase.id}`);
}

console.log(`\n${cases.length - failures}/${cases.length} case(s) matched their expectation.`);
process.exitCode = failures > 0 ? 1 : 0;
