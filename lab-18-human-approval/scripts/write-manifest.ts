import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import pg from "pg";

import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { SCHEMA_VERSION, databaseUrl, migrationFiles } from "../src/db.js";
import { createProposeTool } from "../src/propose-tool.js";
import { mintSecurityContextForTest } from "../src/security-context.js";
import type { ActionService } from "../src/action-service.js";

/**
 * Writes an evidence manifest for one acceptance run to runtime-evidence/ (gitignored). Records
 * what was actually run; anything unavailable is recorded as "unavailable", never omitted.
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

const tool = createProposeTool({
  context: mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "manifest" }),
  actions: {} as ActionService,
  sessionId: "manifest",
  onProposal: () => undefined,
});

let postgres = "unavailable";
try {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  postgres = (await client.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version ?? "unavailable";
  await client.end();
} catch {
  postgres = "unavailable";
}

let deterministic: unknown = "unavailable";
try {
  const raw = execFileSync("npx", ["vitest", "run", "--reporter=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>;
  deterministic = { numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests, numFailedTests: parsed.numFailedTests, success: parsed.success };
} catch (error) {
  deterministic = { success: false, note: `vitest run exited non-zero: ${(error as Error).message.split("\n")[0]}` };
}

const manifest = {
  lab: "lab-18-human-approval",
  timestamp: new Date().toISOString(),
  git: {
    sha: run("git", ["rev-parse", "HEAD"]),
    dirty: run("git", ["status", "--porcelain", "--", "."]) !== "",
    note: "This lab is untracked at manifest time if dirty=true; the SHA alone does not identify the source.",
  },
  runtime: { node: process.version, npm: run("npm", ["--version"]), postgres },
  dependencies: {
    "@earendil-works/pi-ai": versionOf("@earendil-works/pi-ai"),
    jose: versionOf("jose"),
    "@earendil-works/pi-durable": versionOf("@earendil-works/pi-durable"),
    "@earendil-works/chord": versionOf("@earendil-works/chord"),
    pg: versionOf("pg"),
    lockfileSha256: sha256(readFileSync(`${root}package-lock.json`)),
  },
  model: { provider: "faux (scripted)", requestedModelId: "faux-1", providerReportedVersion: "unavailable" },
  hashes: {
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    toolSchemaSha256: sha256(JSON.stringify(tool.parameters)),
    fixtureSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    policySha256: sha256(readFileSync(`${root}src/policy.ts`)),
    migrationsSha256: sha256(migrationFiles().map((file) => readFileSync(`${root}migrations/${file}`, "utf8")).join("\n")),
    evaluationCasesSha256: "not applicable",
  },
  databaseSchemaVersion: SCHEMA_VERSION,
  command: "npx vitest run --reporter=json",
  learnerPrediction: "waived (learner request; see WORKSHEET.md)",
  prerequisiteLabs: { lab15: "skipped", lab17: "skipped (Lab 18 uses a minimal role policy of its own)" },
  results: {
    deterministic,
    integration: "local HTTP + Postgres + scripted provider are part of the deterministic suite; `npm run demo:approval` is a separate scripted run",
    liveModel: "not run",
    realTeamsEntra: "not run (separate acceptance status: pending)",
  },
};

const outDir = `${root}runtime-evidence`;
mkdirSync(outDir, { recursive: true });
const path = `${outDir}/manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[Manifest] wrote ${path}`);
