import "dotenv/config";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseCheckpoint } from "../src/checkpoint.js";
import type { ToolAttempt } from "../src/attempt-log.js";
import type { OutboxRecord } from "../src/outbox-repository.js";

/**
 * The deterministic parent test harness the roadmap requires, run twice — once per
 * replay policy — against the same two-tool harness:
 *
 *   "safe" scenario:  kill after get_container_events' tool_dispatched checkpoint
 *                      (same moment Lab 08 killed at). Expect recovery to re-run the
 *                      tool for real: two attempts, one committed result.
 *   "never" scenario: kill after request_booking_hold's effect_appended checkpoint —
 *                      later than dispatch, because this tool's failure surface is
 *                      "the local effect already happened, the result did not commit."
 *                      Expect recovery to NOT re-run the tool: one attempt, one outbox
 *                      entry, a synthesized interrupted result.
 *
 * Neither scenario sleeps to guess timing — each spawns a child, watches stdout line by
 * line for its own named checkpoint, and sends SIGKILL the instant that line arrives.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const EVIDENCE_ROOT = fileURLToPath(new URL("../runtime-evidence", import.meta.url));

interface ChildRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
}

function runChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => "keep-going" | "kill-now",
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--use-env-proxy", "--import", "tsx", CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines: string[] = [];
    let killedByUs = false;

    const forward = (streamName: "stdout" | "stderr") => {
      const rl = createInterface({ input: child[streamName] });
      rl.on("line", (line) => {
        console.log(`[child:${streamName}] ${line}`);
        lines.push(line);
        if (streamName === "stdout" && onLine(line) === "kill-now" && !killedByUs) {
          killedByUs = true;
          child.kill("SIGKILL");
        }
      });
    };
    forward("stdout");
    forward("stderr");

    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      resolve({ exitCode, signal, lines });
    });
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

interface ScenarioResult {
  attempts: ToolAttempt[];
  outbox: OutboxRecord[];
}

interface ScenarioOptions {
  label: string;
  sessionId: string;
  prompt: string;
  /** Matches the checkpoint line that should get this scenario's first child SIGKILLed. */
  isKillCheckpoint: (checkpoint: { name: string; fields: Record<string, string> }) => boolean;
  attemptsPath: string;
  outboxPath: string;
  envOverrides: NodeJS.ProcessEnv;
}

async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  console.log(`\n########## Scenario: ${options.label} (session=${options.sessionId}) ##########`);

  rmSync(options.attemptsPath, { force: true });
  rmSync(options.outboxPath, { force: true });
  mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const env = {
    ...process.env,
    ...options.envOverrides,
    ATTEMPT_LOG_PATH: options.attemptsPath,
    OUTBOX_PATH: options.outboxPath,
  };

  console.log(`\n=== Step 1: start a turn that will be killed mid-flight ===`);
  const turn1 = await runChild(["--session", options.sessionId, "--prompt", options.prompt], env, (line) => {
    const checkpoint = parseCheckpoint(line);
    return checkpoint && options.isKillCheckpoint(checkpoint) ? "kill-now" : "keep-going";
  });
  console.log(`[demo] turn 1 exited: code=${turn1.exitCode ?? "null"} signal=${turn1.signal ?? "null"}`);
  assert(turn1.signal === "SIGKILL", `${options.label}: turn 1 should have been killed by SIGKILL at its checkpoint`);
  // A model may emit interstitial assistant text alongside its tool call (e.g. "I'll look
  // that up.") before the checkpoint — that is not a final answer. What must never appear
  // is the CLI's own terminal "[Operation] operationId=..." line, which logResult() only
  // prints after prompt() has resolved — impossible for a process that was SIGKILLed first.
  assert(
    !turn1.lines.some((line) => line.startsWith("[Operation] operationId=")),
    `${options.label}: turn 1 must not have reached a terminal operation result`,
  );

  console.log(`\n=== Step 2: reopen and resume the interrupted operation ===`);
  const resume1 = await runChild(["--session", options.sessionId, "--resume"], env, () => "keep-going");
  console.log(`[demo] resume 1 exited: code=${resume1.exitCode ?? "null"} signal=${resume1.signal ?? "null"}`);
  assert(resume1.exitCode === 0, `${options.label}: first resume should exit cleanly and settle the operation`);
  assert(
    resume1.lines.some((line) => /^\[Harness\] lane=main OPEN operation=/.test(line)),
    `${options.label}: first resume should have discovered exactly the operation that was interrupted`,
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Resume] operationId=") && line.includes("status=completed")),
    `${options.label}: first resume should drive the open operation to a completed terminal result`,
  );
  assert(
    resume1.lines.some((line) => line.includes("[Assistant]")),
    `${options.label}: first resume should eventually produce the final assistant answer`,
  );

  console.log(`\n=== Step 3: resume again after settlement ===`);
  const resume2 = await runChild(["--session", options.sessionId, "--resume"], env, () => "keep-going");
  console.log(`[demo] resume 2 exited: code=${resume2.exitCode ?? "null"} signal=${resume2.signal ?? "null"}`);
  assert(resume2.exitCode === 0, `${options.label}: a resume call after settlement is expected, not a failure`);
  assert(
    resume2.lines.some((line) => /^\[Harness\] lane=main openOperationsOnAttach=0$/.test(line)),
    `${options.label}: second resume should find no open operation left`,
  );
  assert(
    resume2.lines.some((line) => line.includes("[Resume] rejected: NothingToResume")),
    `${options.label}: second resume should report NothingToResume explicitly`,
  );

  const attempts = readJsonl<ToolAttempt>(options.attemptsPath);
  const outbox = readJsonl<OutboxRecord>(options.outboxPath);
  console.log(`[demo] ${options.label}: attempts=${attempts.length} outbox=${outbox.length}`);
  return { attempts, outbox };
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const sharedEnv = { SAFE_TOOL_DELAY_MS: "15000", HOLD_TOOL_DELAY_MS: "15000" };

  const safe = await runScenario({
    label: "safe replay (get_container_events)",
    sessionId: `replay-safe-${stamp}`,
    prompt: "What are the movement events for container MSKU1234567?",
    isKillCheckpoint: (checkpoint) => checkpoint.name === "tool_dispatched" && checkpoint.fields.tool === "get_container_events",
    attemptsPath: `${EVIDENCE_ROOT}/attempts-safe.jsonl`,
    outboxPath: `${EVIDENCE_ROOT}/outbox-safe.jsonl`,
    envOverrides: sharedEnv,
  });

  assert(safe.attempts.length === 2, `safe scenario: expected 2 real execute() attempts, got ${safe.attempts.length}`);
  assert(
    safe.attempts[0]?.invocationId === safe.attempts[1]?.invocationId,
    "safe scenario: both attempts must share the same invocationId — recovery replays the same logical call, it does not start a new one",
  );
  assert(safe.attempts[0]?.toolCallId === safe.attempts[1]?.toolCallId, "safe scenario: both attempts must share the same toolCallId");
  assert(safe.outbox.length === 0, "safe scenario: the read-only tool must never write to the outbox");

  const never = await runScenario({
    label: "never replay (request_booking_hold)",
    sessionId: `replay-never-${stamp}`,
    prompt: 'Please place a hold on booking BK1001 for "customs review" and tell me the hold id.',
    isKillCheckpoint: (checkpoint) => checkpoint.name === "effect_appended" && checkpoint.fields.tool === "request_booking_hold",
    attemptsPath: `${EVIDENCE_ROOT}/attempts-never.jsonl`,
    outboxPath: `${EVIDENCE_ROOT}/outbox-never.jsonl`,
    envOverrides: sharedEnv,
  });

  assert(never.attempts.length === 1, `never scenario: expected exactly 1 real execute() attempt, got ${never.attempts.length}`);
  assert(never.outbox.length === 1, `never scenario: expected exactly 1 outbox effect, got ${never.outbox.length} (a duplicate would be a bug)`);
  assert(
    never.attempts[0]?.invocationId === never.outbox[0]?.invocationId,
    "never scenario: the outbox record must carry the same invocationId as the single attempt that produced it",
  );

  console.log("\n########## Evidence summary ##########");
  console.table([
    {
      tool: "get_container_events",
      replay: "safe",
      attempts: safe.attempts.length,
      effects: safe.outbox.length,
      committedResults: 1,
      note: "re-invoked once on recovery; only 1 result ever commits",
    },
    {
      tool: "request_booking_hold",
      replay: "never",
      attempts: never.attempts.length,
      effects: never.outbox.length,
      committedResults: 1,
      note: "recovery synthesizes an interrupted result instead of re-invoking",
    },
  ]);

  console.log("\n=== All Lab 09 tool-replay-safety assertions passed ===");
}

main().catch((error: unknown) => {
  console.error(`[demo] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
