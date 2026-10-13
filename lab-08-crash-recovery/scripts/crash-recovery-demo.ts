import "dotenv/config";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { CHECKPOINT_PREFIX, parseCheckpointName } from "../src/checkpoint.js";

const field = (line: string, name: string): string | undefined => new RegExp(`${name}=(\\S+)`).exec(line)?.[1];

/**
 * The deterministic parent test harness the roadmap requires for Lab 08's failure
 * injection: it never sleeps to guess when the child has reached the interesting state.
 * It spawns the child, watches its stdout line by line for the `[Checkpoint]
 * tool_dispatched` marker `slow-container-events-tool.ts` prints the instant it starts
 * executing, and kills the child the moment that line arrives — after the tool call is
 * durable, before its outcome is committed.
 *
 * Three child processes, three separate `npm run agent` invocations would run as:
 *   1. --prompt "..."       -> killed mid-flight at the checkpoint
 *   2. --resume             -> inspects what was left behind, then settles the submission
 *   3. --resume --settled   -> nothing left to resume; re-reads the stored settled record
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface ChildRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
}

function runChild(args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => "keep-going" | "kill-now"): Promise<ChildRun> {
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

const countKind = (lines: string[], kind: string): number =>
  lines.filter((line) => line.startsWith("[Entry][after]") && line.includes(`kind=${kind}`)).length;

async function main(): Promise<void> {
  const sessionFlagIndex = process.argv.indexOf("--session");
  const sessionId =
    sessionFlagIndex !== -1 && process.argv[sessionFlagIndex + 1]
      ? (process.argv[sessionFlagIndex + 1] as string)
      : `crash-demo-${Date.now()}`;

  // The first child sleeps long inside the tool; the resumed children only need the delay to be short
  // in case the model asks for the lookup again after the interrupted one.
  const killEnv = { ...process.env, SLOW_TOOL_DELAY_MS: process.env.SLOW_TOOL_DELAY_MS ?? "15000" };
  const resumeEnv = { ...process.env, SLOW_TOOL_DELAY_MS: "500" };

  console.log(`\n=== Step 1: start a turn that will be killed mid-flight (session=${sessionId}) ===`);
  const turn1 = await runChild(
    ["--session", sessionId, "--prompt", "What are the movement events for container MSKU1234567?"],
    killEnv,
    (line) => (parseCheckpointName(line) === "tool_dispatched" ? "kill-now" : "keep-going"),
  );
  console.log(`[demo] turn 1 exited: code=${turn1.exitCode ?? "null"} signal=${turn1.signal ?? "null"}`);
  assert(turn1.signal === "SIGKILL", "turn 1 should have been killed by SIGKILL at the checkpoint");
  const checkpoint = turn1.lines.find((line) => parseCheckpointName(line) === "tool_dispatched");
  assert(checkpoint !== undefined, "turn 1 should have printed the tool_dispatched checkpoint before being killed");
  const killedTaskId = field(checkpoint as string, "taskId");
  const killedCallId = field(checkpoint as string, "callId");
  const submissionId = field(turn1.lines.find((line) => line.startsWith("[Submission] admitted")) ?? "", "id");
  assert(killedTaskId !== undefined && killedCallId !== undefined, "the checkpoint line must carry taskId and callId");
  assert(submissionId !== undefined, "turn 1 must have printed the admitted submission id before being killed");
  // The CLI prints `[Submission] id=... status=...` only after submission.wait() resolves, which a
  // process killed mid-tool never reaches.
  assert(
    !turn1.lines.some((line) => line.startsWith("[Submission] id=")),
    "turn 1 must not have reached a settled submission: it was killed before the tool settled",
  );

  console.log(`\n=== Step 2: reopen, inspect, then resume (session=${sessionId}) ===`);
  const resume1 = await runChild(["--session", sessionId, "--resume"], resumeEnv, () => "keep-going");
  console.log(`[demo] resume 1 exited: code=${resume1.exitCode ?? "null"} signal=${resume1.signal ?? "null"}`);
  assert(resume1.exitCode === 0, "first resume should exit cleanly once the submission settles");
  assert(
    resume1.lines.some((line) => /^\[Harness\] scheduling=paused unfinishedTasks=[1-9]\d* unsettledSubmissions=1$/.test(line)),
    "first resume should find unfinished tasks and exactly one unsettled submission, with scheduling still paused",
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Harness] UNFINISHED task=") && line.includes(`task=${killedTaskId} `)),
    `the unfinished tool task reported by inspect() should be the one that was killed (task=${killedTaskId})`,
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Harness] UNSETTLED submission=") && line.includes(`submission=${submissionId} `)),
    `the unsettled submission reported by inspect() should be the one turn 1 admitted (submission=${submissionId})`,
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Resume] submission=") && line.includes("status=done")),
    "first resume should drive the submission to status=done",
  );
  // The interrupted call must not run again. The model may still ask for a *new* lookup after seeing
  // the interrupted result; that would be a different callId, a new call and not a replay.
  assert(
    !resume1.lines.some((line) => parseCheckpointName(line) === "tool_dispatched" && line.includes(`callId=${killedCallId} `)),
    `the interrupted call ${killedCallId} must not be executed again`,
  );
  assert(countKind(resume1.lines, "pi.user") === 1, "recovery must not append a second user prompt");
  const afterResume1 = resume1.lines.find((line) => line.startsWith("[Conversation] entries(after)="));

  console.log(`\n=== Step 3: resume again after settlement (session=${sessionId}) ===`);
  const resume2 = await runChild(["--session", sessionId, "--resume", "--settled"], resumeEnv, () => "keep-going");
  console.log(`[demo] resume 2 exited: code=${resume2.exitCode ?? "null"} signal=${resume2.signal ?? "null"}`);
  assert(resume2.exitCode === 0, "re-reading a settled submission is an expected outcome, not a CLI failure");
  assert(
    resume2.lines.some((line) => /^\[Harness\] scheduling=paused unfinishedTasks=0 unsettledSubmissions=0$/.test(line)),
    "second resume should find nothing unfinished and nothing unsettled",
  );
  assert(
    resume2.lines.some((line) => line.startsWith("[Resume] submission=") && line.includes("status=done")),
    "re-reading the settled submission should return the stored status=done record",
  );
  assert(
    !resume2.lines.some((line) => line.startsWith(CHECKPOINT_PREFIX)),
    "the second resume must not execute any tool",
  );
  assert(
    resume2.lines.find((line) => line.startsWith("[Conversation] entries(after)=")) === afterResume1,
    "the second resume must not add entries: entry count and newest entry stay what the first resume left",
  );
  assert(countKind(resume2.lines, "pi.user") === 1, "exactly one user prompt exists in the whole session");

  console.log("\n=== All Lab 08 crash-recovery assertions passed ===");
}

main().catch((error: unknown) => {
  console.error(`[demo] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
