import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadAllCases, loadCases } from "../src/case-registry.js";
import { calibrateJudge, loadHumanLabels } from "../src/calibration.js";
import { checkReadiness, loadThresholds } from "../src/config.js";
import { deterministicRubricJudge } from "../src/judge.js";
import type { JudgeScore } from "../src/judge.js";
import { exitCodeFor, runReleaseGate } from "../src/release-gate.js";
import { runCases } from "../src/runner.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidenceDir = `${root}runtime-evidence`;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const run = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
};

const readiness = checkReadiness(evidenceDir);
const thresholds = readiness.ready ? loadThresholds() : { minTaskSuccessRate: 0, maxAuthorizationViolationRate: 0, minSemanticScoreFraction: 0, minJudgeAgreementRate: 0, maxWallClockMsP95: 0 };

const heldOutCases = readiness.ready ? loadCases("held-out") : [];
const heldOutOutputs = runCases(heldOutCases);
const heldOutRecords = heldOutOutputs.map((output) => output.record);
const evidenceChecks = heldOutOutputs.map((output) => output.evidence);

const semanticScores = new Map<string, JudgeScore>();
for (const output of heldOutOutputs) {
  const kase = heldOutCases.find((entry) => entry.id === output.record.result.caseId);
  if (kase?.semantic) semanticScores.set(kase.id, deterministicRubricJudge(kase, output.record.result));
}

const allCases = readiness.ready ? loadAllCases() : [];
const labels = readiness.ready ? loadHumanLabels() : [];
const labeledCases = allCases.filter((kase) => labels.some((label) => label.caseId === kase.id));
const labeledResults = runCases(labeledCases).map((output) => output.record.result);
const calibration = calibrateJudge(deterministicRubricJudge, labels, allCases, labeledResults);

const decision = runReleaseGate({ readiness, heldOutRecords, evidenceChecks, semanticScores, calibration, thresholds });

const list = (dir: string, ext: string) => readdirSync(`${root}${dir}`).filter((name) => name.endsWith(ext)).sort();
const hashFiles = (paths: string[]) => sha256(paths.map((path) => readFileSync(`${root}${path}`, "utf8")).join("\n"));
const caseFileHash = sha256([...list("cases/dev", ".json").map((name) => `cases/dev/${name}`), ...list("cases/held-out", ".json").map((name) => `cases/held-out/${name}`)].map((path) => readFileSync(`${root}${path}`, "utf8")).join("\n"));

const manifest = {
  lab: "lab-22-observability-and-release",
  timestamp: new Date().toISOString(),
  git: {
    sha: run("git", ["rev-parse", "HEAD"]),
    dirty: run("git", ["status", "--porcelain", "--", "."]) !== "",
  },
  runtime: { node: process.version, npm: run("npm", ["--version"]) },
  model: "not applicable to the deterministic release-gate path (see npm run evaluate:live for the bounded live layer)",
  boundConfiguration: {
    policySha256: hashFiles(["src/policy.ts", "src/pipeline.ts", "src/invariants.ts"]),
    caseSetSha256: caseFileHash,
    schemaSha256: hashFiles(["src/case-registry.ts", "src/trace.ts"]),
    fixturesSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    releaseThresholdsSha256: sha256(readFileSync(`${root}config/release-thresholds.json`)),
    humanLabelsSha256: sha256(readFileSync(`${root}judge/labels.json`)),
  },
  decision,
  caveat: `sample size: ${decision.sampleSize} held-out case(s), ${calibration.sampleSize} calibration label(s) — a learning-lab fixture set, not a statistical production-reliability claim`,
};

mkdirSync(evidenceDir, { recursive: true });
const manifestPath = `${evidenceDir}/release-manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[release-gate] ${decision.pass ? "PASS" : "FAIL"} — ${decision.reasons.length} reason(s)`);
for (const reason of decision.reasons) {
  console.log(`  [${reason.category}${reason.critical ? ", CRITICAL" : ""}]${reason.caseId ? ` ${reason.caseId}:` : ""} ${reason.detail}`);
}
console.log(`\n${manifest.caveat}`);
console.log(`[release-gate] wrote ${manifestPath}`);

process.exitCode = exitCodeFor(decision);
