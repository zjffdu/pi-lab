import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGetBookingTool } from "../src/get-booking-tool.js";
import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { TenantBookingStore } from "../src/booking-store.js";
import { ScopedCache } from "../src/scoped-cache.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

/**
 * Writes an evidence manifest for one acceptance run to runtime-evidence/ (gitignored). Records
 * what was actually run; anything unavailable is recorded as "unavailable", never omitted. The
 * deterministic result comes from a fresh `vitest run`; there is no integration or live-model
 * result for this lab yet and the manifest says so.
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

const tool = createGetBookingTool(
  mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "manifest" }),
  TenantBookingStore.fromDefaultFixture(),
  new ScopedCache(),
);

let deterministic: unknown = "unavailable";
try {
  const raw = execFileSync("npx", ["vitest", "run", "--reporter=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>;
  deterministic = {
    numTotalTests: parsed.numTotalTests,
    numPassedTests: parsed.numPassedTests,
    numFailedTests: parsed.numFailedTests,
    success: parsed.success,
  };
} catch (error) {
  deterministic = { success: false, note: `vitest run exited non-zero: ${(error as Error).message.split("\n")[0]}` };
}

const manifest = {
  lab: "lab-16-identity-and-isolation",
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
  hashes: {
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    toolSchemaSha256: sha256(JSON.stringify(tool.parameters)),
    fixtureSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    policySha256: "not applicable (resource authorization starts in Lab 17)",
    evaluationCasesSha256: "not applicable",
  },
  databaseSchemaVersion: "not applicable (no database before Lab 18)",
  command: "npx vitest run --reporter=json",
  results: {
    deterministic,
    integration: "local HTTP + scripted provider is part of the deterministic suite; no separate integration run",
    liveModel: "not run",
    realTeamsEntra: "not run (separate acceptance status: pending)",
  },
};

const outDir = `${root}runtime-evidence`;
mkdirSync(outDir, { recursive: true });
const path = `${outDir}/manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[Manifest] wrote ${path}`);
