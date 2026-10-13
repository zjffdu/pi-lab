import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CHECKPOINTS } from "../src/checkpoints.js";
import { SCHEMA_VERSION } from "../src/db.js";
import { DEFAULT_BACKOFF, DEFAULT_MAX_DELIVERY_ATTEMPTS, DEFAULT_MAX_RECONCILE_ATTEMPTS } from "../src/delivery-worker.js";
import { OUTBOX_STATUSES } from "../src/outbox.js";

/**
 * Writes an evidence manifest for one acceptance run to runtime-evidence/ (gitignored). It records what
 * was actually run; anything unavailable is recorded as "unavailable", never omitted. The deterministic
 * result comes from a fresh `vitest run`. No model is involved in this lab, and no real downstream
 * system is part of this manifest.
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

let deterministic: unknown = "unavailable";
try {
  const raw = execFileSync("npx", ["vitest", "run", "--reporter=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>;
  deterministic = { numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests, numFailedTests: parsed.numFailedTests, success: parsed.success };
} catch (error) {
  deterministic = { success: false, note: `vitest run exited non-zero: ${(error as Error).message.split("\n")[0]}` };
}

const list = (dir: string, ext: string) => readdirSync(`${root}${dir}`).filter((name) => name.endsWith(ext)).sort();
const hashFiles = (paths: string[]) => sha256(paths.map((path) => readFileSync(`${root}${path}`, "utf8")).join("\n"));
const policyFiles = ["src/delivery-worker.ts", "src/outbox.ts", "src/idempotency.ts", "src/action-service.ts", "src/receiver/contract.ts", "src/receiver/server.ts", "src/receiver-client.ts", "src/manual-review.ts"];

const manifest = {
  lab: "lab-21-durable-effects",
  timestamp: new Date().toISOString(),
  git: {
    sha: run("git", ["rev-parse", "HEAD"]),
    dirty: run("git", ["status", "--porcelain", "--", "."]) !== "",
    note: "This lab is untracked at manifest time if dirty=true; the SHA alone does not identify the source. SOURCES.sha256 records the Lab 18 files it was copied from.",
  },
  runtime: { node: process.version, npm: run("npm", ["--version"]), postgres: "postgres:16 container (image tag; server version not queried by this script)" },
  dependencies: { pg: versionOf("pg"), lockfileSha256: sha256(readFileSync(`${root}package-lock.json`)) },
  model: "not applicable (nothing in this lab calls a model)",
  configuration: { defaultBackoff: DEFAULT_BACKOFF, maxDeliveryAttempts: DEFAULT_MAX_DELIVERY_ATTEMPTS, maxReconcileAttempts: DEFAULT_MAX_RECONCILE_ATTEMPTS, outboxStatuses: OUTBOX_STATUSES, checkpoints: CHECKPOINTS },
  hashes: {
    policySha256: hashFiles(policyFiles),
    tenantFixtureSha256: sha256(readFileSync(`${root}data/tenants.json`)),
    migrationsSha256: hashFiles([...list("migrations/app", ".sql").map((name) => `migrations/app/${name}`), ...list("migrations/receiver", ".sql").map((name) => `migrations/receiver/${name}`)]),
    evaluationCasesSha256: hashFiles(list("tests", ".test.ts").map((name) => `tests/${name}`)),
    copiedSourcesSha256: sha256(readFileSync(`${root}SOURCES.sha256`)),
  },
  databaseSchemaVersion: SCHEMA_VERSION,
  command: "npx vitest run --reporter=json",
  results: {
    deterministic,
    integration: "local Postgres (two schemas), a local HTTP receiver, and real child worker processes (including SIGKILL) are part of the deterministic suite",
    liveModel: "not applicable",
    realDownstreamSystem: "not run (separate acceptance status: pending; needs a real receiver whose idempotency and lookup semantics are documented)",
  },
};

const outDir = `${root}runtime-evidence`;
mkdirSync(outDir, { recursive: true });
const path = `${outDir}/manifest-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[Manifest] wrote ${path}`);
