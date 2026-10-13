import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { SYSTEM_PROMPT, createRequestRegistry } from "../src/create-harness.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

/**
 * Writes an evidence manifest for one acceptance run to runtime-evidence/ (gitignored). Records what
 * was actually run; anything unavailable is recorded as "unavailable", never omitted. The
 * deterministic result comes from a fresh `vitest run`. No live-model run is part of this manifest.
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

const scratch = mkdtempSync(join(tmpdir(), "pi-lab-19-manifest-"));
const app = await createApp({
  binding: { models: undefined as never, selection: { provider: "faux", modelId: "faux-1" } },
  paths: { sessionsRoot: join(scratch, "sessions") },
  issuerKeysPath: join(scratch, "keys.json"),
});
const operator = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "manifest" });
const { tools } = createRequestRegistry({
  security: operator,
  capabilities: app.capabilities,
  callbacks: { onEvidence: () => undefined, onProposal: () => undefined, onGateViolation: () => undefined, onBoundary: () => undefined },
  assessConversation: async () => undefined,
});
const toolSchemas = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

let deterministic: unknown = "unavailable";
try {
  const raw = execFileSync("npx", ["vitest", "run", "--reporter=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>;
  deterministic = { numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests, numFailedTests: parsed.numFailedTests, success: parsed.success };
} catch (error) {
  deterministic = { success: false, note: `vitest run exited non-zero: ${(error as Error).message.split("\n")[0]}` };
}

const testFiles = readdirSync(`${root}tests`).filter((name) => name.endsWith(".test.ts")).sort();

const manifest = {
  lab: "lab-19-untrusted-context",
  timestamp: new Date().toISOString(),
  git: {
    sha: run("git", ["rev-parse", "HEAD"]),
    dirty: run("git", ["status", "--porcelain", "--", "."]) !== "",
    note: "This lab is untracked at manifest time if dirty=true; the SHA alone does not identify the source.",
  },
  runtime: { node: process.version, npm: run("npm", ["--version"]) },
  dependencies: {
    "@earendil-works/chord": versionOf("@earendil-works/chord"),
    "@earendil-works/pi-ai": versionOf("@earendil-works/pi-ai"),
    "@earendil-works/pi-durable": versionOf("@earendil-works/pi-durable"),
    jose: versionOf("jose"),
    lockfileSha256: sha256(readFileSync(`${root}package-lock.json`)),
  },
  model: { provider: "faux (scripted)", requestedModelId: "faux-1", providerReportedVersion: "unavailable" },
  hashes: {
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    toolSchemaSha256: sha256(JSON.stringify(toolSchemas)),
    tenantFixtureSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    documentFixtureSha256: sha256(readFileSync(`${root}data/documents.json`)),
    policySha256: sha256(["src/acl.ts", "src/outbound-tool.ts", "src/context-provenance.ts", "src/provider-boundary.ts"].map((file) => readFileSync(`${root}${file}`, "utf8")).join("\n")),
    evaluationCasesSha256: sha256(testFiles.map((name) => readFileSync(`${root}tests/${name}`, "utf8")).join("\n")),
  },
  databaseSchemaVersion: "not applicable (this lab keeps no database; the proposal ledger is in-memory)",
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
