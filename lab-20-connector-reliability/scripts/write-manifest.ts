import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_MODEL_CALL, SYSTEM_PROMPT } from "../src/create-harness.js";
import { createLookupBookingTool } from "../src/booking-tool.js";
import { DEFAULT_RETRY } from "../src/connector/http-connector.js";
import { DEFAULT_LIMITS } from "../src/run-budget.js";
import { DEFAULT_QUEUE } from "../src/app.js";
import { AttemptTrace } from "../src/connector/trace.js";
import { RunBudget } from "../src/run-budget.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

/**
 * Writes an evidence manifest for one acceptance run to runtime-evidence/ (gitignored). Records what
 * was actually run; anything unavailable is recorded as "unavailable", never omitted. The
 * deterministic result comes from a fresh `vitest run`. No live-model run and no real-endpoint run is
 * part of this manifest.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const run = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
};

const lock = JSON.parse(readFileSync(`${root}package-lock.json`, "utf8")) as { packages: Record<string, { version?: string }> };
const versionOf = (name: string) => lock.packages[`node_modules/${name}`]?.version ?? "unavailable";

const tool = createLookupBookingTool({
  context: mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "manifest" }),
  lookup: undefined as never,
  budget: new RunBudget(DEFAULT_LIMITS),
  trace: new AttemptTrace(),
  onLookup: () => undefined,
});

let deterministic: unknown = "unavailable";
try {
  const raw = execFileSync("npx", ["vitest", "run", "--reporter=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>;
  deterministic = { numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests, numFailedTests: parsed.numFailedTests, success: parsed.success };
} catch (error) {
  deterministic = { success: false, note: `vitest run exited non-zero: ${(error as Error).message.split("\n")[0]}` };
}

const testFiles = readdirSync(`${root}tests`).filter((name) => name.endsWith(".test.ts")).sort();
const policyFiles = ["src/connector/errors.ts", "src/connector/http-connector.ts", "src/run-budget.ts", "src/admission-queue.ts", "src/create-harness.ts", "src/chat-service.ts", "src/model-limits.ts"];

const manifest = {
  lab: "lab-20-connector-reliability",
  timestamp: new Date().toISOString(),
  git: {
    sha: run("git", ["rev-parse", "HEAD"]),
    dirty: run("git", ["status", "--porcelain", "--", "."]) !== "",
    note: "This lab is untracked at manifest time if dirty=true; the SHA alone does not identify the source.",
  },
  runtime: { node: process.version, npm: run("npm", ["--version"]) },
  dependencies: {
    "@earendil-works/pi-durable": versionOf("@earendil-works/pi-durable"),
    "@earendil-works/pi-ai": versionOf("@earendil-works/pi-ai"),
    "@earendil-works/chord": versionOf("@earendil-works/chord"),
    jose: versionOf("jose"),
    lockfileSha256: sha256(readFileSync(`${root}package-lock.json`)),
  },
  model: { provider: "faux (scripted)", requestedModelId: "faux-1", providerReportedVersion: "unavailable" },
  configuration: { defaultLimits: DEFAULT_LIMITS, defaultConnectorRetry: DEFAULT_RETRY, defaultModelCall: DEFAULT_MODEL_CALL, defaultQueue: DEFAULT_QUEUE },
  hashes: {
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    toolSchemaSha256: sha256(JSON.stringify([{ name: tool.name, parameters: tool.parameters }])),
    tenantFixtureSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    bookingApiFixtureSha256: sha256(readFileSync(`${root}data/bookings.json`)),
    policySha256: sha256(policyFiles.map((file) => readFileSync(`${root}${file}`, "utf8")).join("\n")),
    evaluationCasesSha256: sha256(testFiles.map((name) => readFileSync(`${root}tests/${name}`, "utf8")).join("\n")),
  },
  databaseSchemaVersion: "not applicable (this lab keeps no database)",
  command: "npx vitest run --reporter=json",
  results: {
    deterministic,
    integration: "local HTTP front door + fake booking API + scripted provider are part of the deterministic suite; no separate integration run",
    liveModel: "not run",
    realBookingEndpoint: "not run (separate acceptance status: pending; needs an authorized read-only endpoint)",
    realTeamsEntra: "not run (separate acceptance status: pending)",
  },
};

const outDir = `${root}runtime-evidence`;
mkdirSync(outDir, { recursive: true });
const path = `${outDir}/manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[Manifest] wrote ${path}`);
