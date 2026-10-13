import "dotenv/config";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { ToolAttempt } from "../src/attempt-log.js";
import { CHECKPOINT_PREFIX, type ParsedCheckpoint, parseCheckpoint } from "../src/checkpoint.js";
import type { OutboxRecord } from "../src/outbox-repository.js";

/**
 * The deterministic parent test harness the roadmap requires, run twice, once per replay policy,
 * against the same two-tool harness:
 *
 *   "safe" scenario:   kill after get_container_events' tool_dispatched checkpoint (the moment Lab 08
 *                      killed at). Recovery runs the tool again for real: two attempts, one result.
 *   "unsafe" scenario: kill after request_booking_hold's effect_appended checkpoint, later than
 *                      dispatch, because this tool's failure surface is "the local effect already
 *                      happened, the result did not commit". Recovery must NOT run the tool again:
 *                      one attempt, one outbox entry, an `interrupted` result.
 *
 * Neither scenario sleeps to guess timing: each spawns a child, reads its stdout line by line for its
 * own named checkpoint, and sends SIGKILL the instant that line arrives.
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

const field = (line: string, name: string): string | undefined => new RegExp(`${name}=(\\S+)`).exec(line)?.[1];

const entryLines = (lines: string[], kind: string): string[] =>
  lines.filter((line) => line.startsWith("[Entry][after]") && line.includes(`kind=${kind}`));

interface ScenarioResult {
  label: string;
  tool: string;
  replay: string;
  killedCallId: string;
  attempts: ToolAttempt[];
  outbox: OutboxRecord[];
  committedResults: number;
  resultStatus: string;
}

interface ScenarioOptions {
  label: string;
  tool: string;
  replay: "safe" | "unsafe";
  sessionId: string;
  prompt: string;
  /** Matches the checkpoint line that should get this scenario's first child SIGKILLed. */
  isKillCheckpoint: (checkpoint: ParsedCheckpoint) => boolean;
  attemptsPath: string;
  outboxPath: string;
}

async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const { label, tool, sessionId } = options;
  console.log(`\n########## Scenario: ${label} (session=${sessionId}) ##########`);

  rmSync(options.attemptsPath, { force: true });
  rmSync(options.outboxPath, { force: true });
  mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const base = { ...process.env, ATTEMPT_LOG_PATH: options.attemptsPath, OUTBOX_PATH: options.outboxPath };
  // The first child sleeps long inside its tool so the kill lands mid-call. The recovering children use a
  // short delay: a safe tool is run again there, and should finish quickly.
  const killEnv = { ...base, SAFE_TOOL_DELAY_MS: "15000", HOLD_TOOL_DELAY_MS: "15000" };
  const resumeEnv = { ...base, SAFE_TOOL_DELAY_MS: "500", HOLD_TOOL_DELAY_MS: "500" };

  console.log(`\n=== Step 1: start a turn that will be killed mid-flight ===`);
  const turn1 = await runChild(["--session", sessionId, "--prompt", options.prompt], killEnv, (line) => {
    const checkpoint = parseCheckpoint(line);
    return checkpoint && options.isKillCheckpoint(checkpoint) ? "kill-now" : "keep-going";
  });
  console.log(`[demo] turn 1 exited: code=${turn1.exitCode ?? "null"} signal=${turn1.signal ?? "null"}`);
  assert(turn1.signal === "SIGKILL", `${label}: turn 1 should have been killed by SIGKILL at its checkpoint`);
  const killCheckpoint = turn1.lines.map(parseCheckpoint).find((c) => c && options.isKillCheckpoint(c));
  assert(killCheckpoint !== undefined, `${label}: turn 1 should have printed its kill checkpoint`);
  const killedTaskId = killCheckpoint?.fields.taskId;
  const killedCallId = killCheckpoint?.fields.callId;
  if (killedTaskId === undefined || killedCallId === undefined) {
    throw new Error(`Assertion failed: ${label}: the checkpoint must carry taskId and callId`);
  }
  const submissionId = field(turn1.lines.find((line) => line.startsWith("[Submission] admitted")) ?? "", "id");
  assert(submissionId !== undefined, `${label}: turn 1 must have printed the admitted submission id`);
  // `[Submission] id=...` is printed only after submission.wait() resolves, which a process killed mid-tool never reaches.
  assert(!turn1.lines.some((line) => line.startsWith("[Submission] id=")), `${label}: turn 1 must not have settled its submission`);

  console.log(`\n=== Step 2: reopen, inspect, then resume ===`);
  const resume1 = await runChild(["--session", sessionId, "--resume"], resumeEnv, () => "keep-going");
  console.log(`[demo] resume 1 exited: code=${resume1.exitCode ?? "null"} signal=${resume1.signal ?? "null"}`);
  assert(resume1.exitCode === 0, `${label}: first resume should exit cleanly once the submission settles`);
  assert(
    resume1.lines.some((line) => /^\[Harness\] scheduling=paused unfinishedTasks=[1-9]\d* unsettledSubmissions=1$/.test(line)),
    `${label}: first resume should find unfinished tasks and one unsettled submission, scheduling still paused`,
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Harness] UNFINISHED task=") && line.includes(`task=${killedTaskId} kind=pi.tool`)),
    `${label}: inspect() should report the killed pi.tool task (task=${killedTaskId})`,
  );
  // The policy committed with the call's intent is visible before anything runs.
  assert(
    resume1.lines.some((line) => line.startsWith("[Harness] UNFINISHED task=") && line.includes(`task=${killedTaskId} kind=pi.tool`) && line.includes(` replay=${options.replay} `)),
    `${label}: inspect() should show replay=${options.replay} on the killed tool task`,
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Resume] submission=") && line.includes(`submission=${submissionId} status=done`)),
    `${label}: first resume should settle submission ${submissionId} as done`,
  );
  assert(entryLines(resume1.lines, "pi.user").length === 1, `${label}: recovery must not append a second user prompt`);
  const committed = entryLines(resume1.lines, "pi.tool-result");
  const replayedCheckpoints = resume1.lines.filter((line) => {
    const c = parseCheckpoint(line);
    return c?.fields.callId === killedCallId;
  });
  const resultStatus = resume1.lines.find((line) => line.includes(`toolResult ${tool} status=`)) ?? "";

  console.log(`\n=== Step 3: ask again after settlement ===`);
  const resume2 = await runChild(["--session", sessionId, "--resume", "--settled"], resumeEnv, () => "keep-going");
  console.log(`[demo] resume 2 exited: code=${resume2.exitCode ?? "null"} signal=${resume2.signal ?? "null"}`);
  assert(resume2.exitCode === 0, `${label}: re-reading a settled submission is expected, not a failure`);
  assert(
    resume2.lines.some((line) => /^\[Harness\] scheduling=paused unfinishedTasks=0 unsettledSubmissions=0$/.test(line)),
    `${label}: second resume should find nothing unfinished and nothing unsettled`,
  );
  assert(
    resume2.lines.some((line) => line.startsWith("[Resume] submission=") && line.includes(`submission=${submissionId} status=done`)),
    `${label}: re-reading the settled submission should return its stored done record`,
  );
  assert(!resume2.lines.some((line) => line.startsWith(CHECKPOINT_PREFIX)), `${label}: the second resume must not execute any tool`);
  assert(
    resume2.lines.find((line) => line.startsWith("[Conversation] entries(after)=")) ===
      resume1.lines.find((line) => line.startsWith("[Conversation] entries(after)=")),
    `${label}: the second resume must not add entries`,
  );

  const attempts = readJsonl<ToolAttempt>(options.attemptsPath);
  const outbox = readJsonl<OutboxRecord>(options.outboxPath);
  console.log(`[demo] ${label}: attempts=${attempts.length} outbox=${outbox.length}`);

  // A model that asks again after seeing an interrupted result makes a NEW call with a new call id: a
  // retry, not a replay. These checks are about the killed call's identity only.
  const ofKilled = attempts.filter((attempt) => attempt.callId === killedCallId);
  assert(ofKilled.every((attempt) => attempt.taskId === killedTaskId), `${label}: every attempt of the killed call must carry its task id`);
  if (options.replay === "safe") {
    assert(ofKilled.length === 2, `${label}: a safe tool should be executed twice for the killed call, got ${ofKilled.length}`);
    assert(replayedCheckpoints.length === 1, `${label}: the recovering process should announce exactly one replayed dispatch`);
    assert(resultStatus.includes("status=success"), `${label}: the committed result should be the real one, got: ${resultStatus}`);
  } else {
    assert(ofKilled.length === 1, `${label}: an unsafe tool must be executed once for the killed call, got ${ofKilled.length}`);
    assert(replayedCheckpoints.length === 0, `${label}: the recovering process must not dispatch the killed call again`);
    assert(resultStatus.includes("status=error"), `${label}: the committed result should be the interrupted error, got: ${resultStatus}`);
    const effectsOfKilled = outbox.filter((record) => record.callId === killedCallId);
    assert(effectsOfKilled.length === 1, `${label}: exactly one outbox effect for the killed call, got ${effectsOfKilled.length} (a duplicate would be a bug)`);
    assert(effectsOfKilled[0]?.taskId === killedTaskId, `${label}: the outbox record must carry the killed call's task id`);
  }

  const distinctCalls = new Set(attempts.map((attempt) => attempt.callId)).size;
  if (distinctCalls > 1) {
    console.log(`[demo] note: the model made ${distinctCalls - 1} further call(s) with new call ids after recovery (a retry, not a replay)`);
  }

  return {
    label,
    tool,
    replay: options.replay,
    killedCallId,
    attempts,
    outbox,
    committedResults: committed.length,
    resultStatus: resultStatus.includes("status=error") ? "interrupted (isError)" : "real result",
  };
}

async function main(): Promise<void> {
  const stamp = Date.now();

  const safe = await runScenario({
    label: "safe replay (get_container_events)",
    tool: "get_container_events",
    replay: "safe",
    sessionId: `replay-safe-${stamp}`,
    prompt: "What are the movement events for container MSKU1234567?",
    isKillCheckpoint: (c) => c.name === "tool_dispatched" && c.fields.tool === "get_container_events",
    attemptsPath: `${EVIDENCE_ROOT}/attempts-safe.jsonl`,
    outboxPath: `${EVIDENCE_ROOT}/outbox-safe.jsonl`,
  });
  assert(safe.outbox.length === 0, "safe scenario: the read-only tool must never write to the outbox");

  const unsafe = await runScenario({
    label: "unsafe replay (request_booking_hold)",
    tool: "request_booking_hold",
    replay: "unsafe",
    sessionId: `replay-unsafe-${stamp}`,
    prompt: 'Please place a hold on booking BK1001 for "customs review" and tell me the hold id.',
    isKillCheckpoint: (c) => c.name === "effect_appended" && c.fields.tool === "request_booking_hold",
    attemptsPath: `${EVIDENCE_ROOT}/attempts-unsafe.jsonl`,
    outboxPath: `${EVIDENCE_ROOT}/outbox-unsafe.jsonl`,
  });

  const row = (r: ScenarioResult) => {
    const ofKilled = r.attempts.filter((a) => a.callId === r.killedCallId);
    return {
      tool: r.tool,
      replay: r.replay,
      "executions of the killed call": ofKilled.length,
      replays: ofKilled.length - 1,
      "new calls by the model (retries)": new Set(r.attempts.map((a) => a.callId)).size - 1,
      "outbox effects": r.outbox.filter((o) => o.callId === r.killedCallId).length,
      "committed results": r.committedResults,
      "committed result is": r.resultStatus,
    };
  };

  console.log("\n########## Evidence summary ##########");
  console.table([row(safe), row(unsafe)]);

  console.log("\n=== All Lab 09 tool-replay-safety assertions passed ===");
}

main().catch((error: unknown) => {
  console.error(`[demo] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
