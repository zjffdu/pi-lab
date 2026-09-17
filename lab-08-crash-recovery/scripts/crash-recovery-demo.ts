import "dotenv/config";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseCheckpointName } from "../src/checkpoint.js";

/**
 * The deterministic parent test harness the roadmap requires for Lab 08's failure
 * injection: it never sleeps to guess when the child has reached the interesting state.
 * It spawns the child, watches its stdout line by line for the `[Checkpoint]
 * tool_dispatched` marker `slow-container-events-tool.ts` prints the instant it starts
 * executing, and kills the child the moment that line arrives — after the tool call is
 * durable, before its outcome is committed.
 *
 * Three child processes, three separate `npm run agent` invocations would run as:
 *   1. --prompt "..."  -> killed mid-flight at the checkpoint
 *   2. --resume        -> should discover the open operation and settle it
 *   3. --resume        -> should report NothingToResume, not repeat any work
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

async function main(): Promise<void> {
  const sessionFlagIndex = process.argv.indexOf("--session");
  const sessionId =
    sessionFlagIndex !== -1 && process.argv[sessionFlagIndex + 1]
      ? (process.argv[sessionFlagIndex + 1] as string)
      : `crash-demo-${Date.now()}`;

  const env = {
    ...process.env,
    SLOW_TOOL_DELAY_MS: process.env.SLOW_TOOL_DELAY_MS ?? "15000",
  };

  console.log(`\n=== Step 1: start a turn that will be killed mid-flight (session=${sessionId}) ===`);
  const turn1 = await runChild(
    ["--session", sessionId, "--prompt", "What are the movement events for container MSKU1234567?"],
    env,
    (line) => (parseCheckpointName(line) === "tool_dispatched" ? "kill-now" : "keep-going"),
  );
  console.log(`[demo] turn 1 exited: code=${turn1.exitCode ?? "null"} signal=${turn1.signal ?? "null"}`);
  assert(turn1.signal === "SIGKILL", "turn 1 should have been killed by SIGKILL at the checkpoint");
  assert(
    turn1.lines.some((line) => parseCheckpointName(line) === "tool_dispatched"),
    "turn 1 should have printed the tool_dispatched checkpoint before being killed",
  );
  assert(
    !turn1.lines.some((line) => line.includes("[Assistant]")),
    "turn 1 must not have produced a final assistant answer — it was killed before the tool settled",
  );

  console.log(`\n=== Step 2: reopen and resume the interrupted operation (session=${sessionId}) ===`);
  const resume1 = await runChild(["--session", sessionId, "--resume"], env, () => "keep-going");
  console.log(`[demo] resume 1 exited: code=${resume1.exitCode ?? "null"} signal=${resume1.signal ?? "null"}`);
  assert(resume1.exitCode === 0, "first resume should exit cleanly and settle the operation");
  assert(
    resume1.lines.some((line) => /^\[Harness\] lane=main OPEN operation=/.test(line)),
    "first resume should have discovered exactly the operation that was interrupted",
  );
  assert(
    resume1.lines.some((line) => line.startsWith("[Resume] operationId=") && line.includes("status=completed")),
    "first resume should drive the open operation to a completed terminal result",
  );
  assert(
    resume1.lines.some((line) => line.includes("[Assistant]")),
    "first resume should eventually produce the final assistant answer",
  );

  console.log(`\n=== Step 3: resume again after settlement (session=${sessionId}) ===`);
  const resume2 = await runChild(["--session", sessionId, "--resume"], env, () => "keep-going");
  console.log(`[demo] resume 2 exited: code=${resume2.exitCode ?? "null"} signal=${resume2.signal ?? "null"}`);
  assert(resume2.exitCode === 0, "a resume call after settlement is an expected outcome, not a CLI failure");
  assert(
    resume2.lines.some((line) => /^\[Harness\] lane=main openOperationsOnAttach=0$/.test(line)),
    "second resume should find no open operation left",
  );
  assert(
    resume2.lines.some((line) => line.includes("[Resume] rejected: NothingToResume")),
    "second resume should report NothingToResume explicitly rather than silently repeating work",
  );
  assert(
    !resume2.lines.some((line) => line.includes("tool_dispatched")),
    "second resume must not re-invoke the slow tool",
  );

  console.log("\n=== All Lab 08 crash-recovery assertions passed ===");
}

main().catch((error: unknown) => {
  console.error(`[demo] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
