import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { BookingRepository } from "../src/booking-repository.js";
import { createGetBookingTool } from "../src/get-booking-tool.js";
import { createUpdateBookingStatusTool } from "../src/update-booking-status-tool.js";
import { ACCEPTANCE, INJECTIONS } from "./acceptance-map.js";

/**
 * Writes three artifacts to the ignored `runtime-evidence/` directory:
 *   manifest.json    — what was run, on what, with what versions and hashes
 *   experiments.json — the failure injections and what each showed
 *   acceptance.json  — each roadmap criterion, judged from the real test results
 * Nothing here reads the environment, so no credential can end up in an artifact.
 * Exit status is non-zero if any test fails or any criterion is `failed`/`unmapped`.
 * `partial` (passes, with stated limits) does not fail the run: it is reported, not hidden.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "runtime-evidence");

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const run = (command: string, args: string[], cwd = ROOT) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (command: string, args: string[], cwd = ROOT) => {
  try {
    return run(command, args, cwd);
  } catch {
    return "unavailable";
  }
};

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function sourceSnapshot(): string {
  const files = ["src", "tests", "scripts", "data"].flatMap((d) => listFiles(join(ROOT, d))).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(relative(ROOT, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

interface VitestAssertion { fullName: string; status: string }
interface VitestFile { name: string; assertionResults: VitestAssertion[] }

function runTests(): { exitStatus: number; files: VitestFile[] } {
  const outputFile = join(tmpdir(), `lab15-vitest-${process.pid}.json`);
  let exitStatus = 0;
  try {
    run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`]);
  } catch (error) {
    exitStatus = (error as { status?: number }).status ?? 1;
  }
  const parsed = JSON.parse(readFileSync(outputFile, "utf8")) as { testResults: VitestFile[] };
  return { exitStatus, files: parsed.testResults };
}

const layerOf = (file: string) =>
  file.endsWith("booking-repository.test.ts") ? "unit-and-contract" : "scripted-runtime-integration";

function judge(matches: readonly string[], tests: VitestAssertion[]) {
  const found = matches.map((match) => ({ match, tests: tests.filter((t) => t.fullName.includes(match)) }));
  const unmapped = found.filter((f) => f.tests.length === 0).map((f) => f.match);
  const matched = found.flatMap((f) => f.tests);
  const allPass = matched.length > 0 && matched.every((t) => t.status === "passed");
  return { unmapped, allPass, matched: [...new Map(matched.map((t) => [t.fullName, t.status])).entries()].map(([name, status]) => ({ name, status })) };
}

const { exitStatus, files } = runTests();
const tests = files.flatMap((f) => f.assertionResults);
const failed = tests.filter((t) => t.status !== "passed").length;

const acceptance = ACCEPTANCE.map((criterion) => {
  const { unmapped, allPass, matched } = judge(criterion.matches, tests);
  const status = unmapped.length > 0 ? "unmapped" : !allPass ? "failed" : criterion.limited ? "partial" : "verified";
  return { id: criterion.id, criterion: criterion.criterion, status, tests: matched, unmappedMatches: unmapped, caveats: criterion.caveats };
});

const experiments = INJECTIONS.map((injection) => {
  const { unmapped, allPass, matched } = judge(injection.matches, tests);
  return { injection: injection.injection, observed: injection.observed, pinnedBy: matched, unmappedMatches: unmapped, held: unmapped.length === 0 && allPass };
});

const repository = BookingRepository.fromDefaultFixture();
const toolSchemas = [createGetBookingTool(repository), createUpdateBookingStatusTool(repository)].map((t) => ({ name: t.name, parameters: t.parameters }));
const gitRoot = tryRun("git", ["rev-parse", "--show-toplevel"]);
const dirtyLines = gitRoot === "unavailable" ? [] : tryRun("git", ["status", "--porcelain"], gitRoot).split("\n").filter(Boolean);
const versionOf = (pkg: string) => (JSON.parse(readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf8")) as { version: string }).version;

const manifest = {
  generatedAt: new Date().toISOString(),
  command: "npm run evidence",
  git: {
    sha: tryRun("git", ["rev-parse", "HEAD"]),
    dirty: dirtyLines.length > 0,
    dirtyEntryCount: dirtyLines.length,
    sourceSnapshotSha256: sourceSnapshot(),
    note: "Labs 13 and 14 (sources copied into this lab) are untracked, so no clean SHA identifies them.",
  },
  environment: {
    node: process.version,
    npm: tryRun("npm", ["-v"]),
    pi: {
      durable: versionOf("@earendil-works/pi-durable"),
      chord: versionOf("@earendil-works/chord"),
      ai: versionOf("@earendil-works/pi-ai"),
      telemetry: versionOf("@earendil-works/pi-telemetry"),
    },
    lockfileSha256: sha256(readFileSync(join(ROOT, "package-lock.json"))),
  },
  model: { provider: "faux (pi-ai fauxProvider, scripted responses)", requestedModelId: "faux default", providerReportedVersion: "unavailable" },
  hashes: {
    systemPrompt: sha256(SYSTEM_PROMPT),
    toolSchemas: sha256(JSON.stringify(toolSchemas)),
    policy: sha256(readFileSync(join(ROOT, "src", "tool-policy.ts"))),
    fixtures: sha256(readFileSync(join(ROOT, "data", "bookings.json"))),
    acceptanceMap: sha256(readFileSync(join(ROOT, "scripts", "acceptance-map.ts"))),
    evaluationCases: "unavailable (this lab has no evaluation cases)",
  },
  databaseSchemaVersion: "unavailable (no persistent business state in this lab)",
  results: {
    deterministic: {
      note: "All tests run without a network, a live model, or an enterprise service.",
      exitStatus,
      total: tests.length,
      passed: tests.length - failed,
      failed,
      byFile: files.map((f) => ({ file: relative(ROOT, f.name), layer: layerOf(f.name), total: f.assertionResults.length, failed: f.assertionResults.filter((t) => t.status !== "passed").length })),
    },
    liveModel: { status: "not run", reason: "Lab 15's criteria are about composition guarantees, decided with scripted responses. No claim here rests on a live model." },
    enterpriseIntegration: { status: "not applicable" },
  },
  independentReview: { status: "not performed", note: "Authoring and verification were done in one session; no separate reviewer pass." },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(OUT, "experiments.json"), `${JSON.stringify(experiments, null, 2)}\n`);
writeFileSync(join(OUT, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);

const count = (status: string) => acceptance.filter((a) => a.status === status).length;
console.log(`tests: ${tests.length - failed}/${tests.length} passed`);
console.log(`acceptance: ${count("verified")} verified, ${count("partial")} partial, ${count("failed")} failed, ${count("unmapped")} unmapped`);
for (const a of acceptance) console.log(`  ${a.id} ${a.status.padEnd(9)} ${a.criterion}`);
console.log(`experiments held: ${experiments.filter((e) => e.held).length}/${experiments.length}`);
console.log(`artifacts: ${relative(process.cwd(), OUT)}/{manifest,experiments,acceptance}.json`);

if (exitStatus !== 0 || failed > 0 || count("failed") > 0 || count("unmapped") > 0 || experiments.some((e) => !e.held)) process.exit(1);
