import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { RunResult, ResumeResult } from "@earendil-works/pi-agent-core";

import { openMainLane } from "./create-harness.js";
import { attachHarnessTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "./session-store.js";

/** Fixed grouping key, same role as Lab 07's `SESSION_GROUP` — see `openOrCreateSession`. */
const SESSION_GROUP = "lab-08-crash-recovery";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface CliArgs {
  sessionId: string;
  prompt: string | undefined;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let resume = false;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else if (flag === "--resume") {
      resume = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".`);
    }
  }

  if (!sessionId) {
    throw new Error(
      'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
        "   or: npm run agent -- --session <id> --resume\n" +
        "One CLI invocation is one turn or one resume attempt against one named session.",
    );
  }
  if (resume && prompt) {
    throw new Error("--resume and --prompt are mutually exclusive: a resume attempt sends no new prompt.");
  }
  if (!resume && !prompt) {
    throw new Error('Either --prompt "<text>" or --resume is required.');
  }

  return { sessionId, prompt, resume };
}

/** Returns true when the operation should be treated as a CLI failure. `NothingToResume` is
 * an expected, explicit terminal outcome for a second resume attempt — not a failure. */
function logResult(label: string, result: RunResult | ResumeResult): boolean {
  if (!result.ok) {
    console.log(`[${label}] rejected: ${result.error._tag}: ${result.error.message}`);
    return result.error._tag !== "NothingToResume";
  }

  if (result.value.status === "suspended") {
    console.log(
      `[${label}] operationId=${result.value.operationId} status=suspended (deferred provider response)`,
    );
    return false;
  }

  const record = result.value;
  console.log(
    `[${label}] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
      `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"} ` +
      `startedAt=${record.startedAt} endedAt=${record.endedAt}`,
  );
  if (record.status !== "completed" && record.error) {
    console.error(`[Fatal] operation ${record.status}: ${record.error.code}: ${record.error.message}`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const { sessionId, prompt, resume } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session, created } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);

  console.log(
    `[Session] id=${session.metadata.id} ${created ? "created" : "reopened"} ` +
      `path=${session.metadata.path}`,
  );

  const { harness, lane, open } = await openMainLane(session, context);

  console.log(`[Harness] lane=main openOperationsOnAttach=${open.length}`);
  for (const operation of open) {
    console.log(
      `[Harness] lane=${operation.lane} OPEN operation=${operation.operationId} ` +
        `kind=${operation.kind} startedAt=${operation.startedAt}${operation.aborting ? " aborting=true" : ""}`,
    );
  }

  const tipBefore = await lane.getTipId(context);
  console.log(`[Lane] tipId(before)=${tipBefore ?? "null"}`);

  const entriesBefore = await lane.findEntries(undefined, context);
  console.log(`[Lane] entries(before)=${entriesBefore.length}`);
  for (const entry of [...entriesBefore].sort((a, b) => a.seq - b.seq)) {
    let detail = "";
    if (entry.type === "message") {
      detail = ` role=${entry.message.role}`;
      if (entry.message.role === "toolResult") {
        detail += ` toolCallId=${entry.message.toolCallId}`;
      }
    }
    console.log(
      `[Entry][before] seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} type=${entry.type}${detail}`,
    );
  }

  const detachLogger = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));

  let failed = false;
  if (resume) {
    console.log(`[Resume][${sessionId}] inspecting open operation before calling lane.resume()`);
    const result = await lane.resume(context);
    failed = logResult("Resume", result);
  } else {
    console.log(`[User][${sessionId}] ${prompt}`);
    const result = await lane.prompt(prompt as string, undefined, context);
    failed = logResult("Operation", result);
  }

  detachLogger();

  const tipAfter = await lane.getTipId(context);
  console.log(`[Lane] tipId(after)=${tipAfter ?? "null"}`);

  const entriesAfter = await lane.findEntries(undefined, context);
  console.log(`[Lane] entries(after)=${entriesAfter.length}`);
  for (const entry of [...entriesAfter].sort((a, b) => a.seq - b.seq)) {
    let detail = "";
    if (entry.type === "message") {
      detail = ` role=${entry.message.role}`;
      if (entry.message.role === "toolResult") {
        detail += ` toolCallId=${entry.message.toolCallId}`;
      }
    }
    console.log(
      `[Entry][after] seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} type=${entry.type}${detail}`,
    );
  }

  await harness.close(context);
  await repo.close(context);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
