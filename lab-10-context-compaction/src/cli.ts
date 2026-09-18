import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { CompactionResult, RunResult } from "@earendil-works/pi-agent-core";

import { openMainLane } from "./create-harness.js";
import { attachContextTokenHook, attachHarnessTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "./session-store.js";

/** Fixed grouping key, same role as earlier labs' `SESSION_GROUP` — see `openOrCreateSession`. */
const SESSION_GROUP = "lab-10-context-compaction";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface CliArgs {
  sessionId: string;
  prompt: string | undefined;
  compact: boolean;
  customInstructions: string | undefined;
  inspect: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let compact = false;
  let customInstructions: string | undefined;
  let inspect = false;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else if (flag === "--compact") {
      compact = true;
      index += 1;
    } else if (flag === "--custom-instructions") {
      customInstructions = argv[index + 1];
      index += 2;
    } else if (flag === "--inspect") {
      inspect = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".`);
    }
  }

  if (!sessionId) {
    throw new Error(
      'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
        '   or: npm run agent -- --session <id> --compact [--custom-instructions "<text>"]\n' +
        "   or: npm run agent -- --session <id> --inspect\n" +
        "One CLI invocation is one turn, one compaction attempt, or one read-only inspection.",
    );
  }
  const modeCount = [Boolean(prompt), compact, inspect].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Exactly one of --prompt, --compact, or --inspect is required.");
  }
  if (customInstructions && !compact) {
    throw new Error("--custom-instructions only applies to --compact.");
  }

  return { sessionId, prompt, compact, customInstructions, inspect };
}

function logRunResult(label: string, result: RunResult): boolean {
  if (!result.ok) {
    console.log(`[${label}] rejected: ${result.error._tag}: ${result.error.message}`);
    return true;
  }
  if (result.value.status === "suspended") {
    console.log(`[${label}] operationId=${result.value.operationId} status=suspended (deferred provider response)`);
    return false;
  }
  const record = result.value;
  console.log(
    `[${label}] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
      `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"}`,
  );
  if (record.status !== "completed" && record.error) {
    console.error(`[Fatal] operation ${record.status}: ${record.error.code}: ${record.error.message}`);
    return true;
  }
  return false;
}

function logCompactionResult(result: CompactionResult): boolean {
  if (!result.ok) {
    console.log(`[Compact] rejected: ${result.error._tag}: ${result.error.message}`);
    return true;
  }
  const record = result.value.compaction;
  console.log(
    `[Compact] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
      `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"}`,
  );
  if (record.status !== "completed" && record.error) {
    console.error(`[Fatal] compaction ${record.status}: ${record.error.code}: ${record.error.message}`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const { sessionId, prompt, compact, customInstructions, inspect } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session, created } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);

  console.log(
    `[Session] id=${session.metadata.id} ${created ? "created" : "reopened"} path=${session.metadata.path}`,
  );

  const { harness, lane, open } = await openMainLane(session, context);
  console.log(`[Harness] lane=main openOperationsOnAttach=${open.length}`);

  const tipBefore = await lane.getTipId(context);
  const entriesBefore = await lane.findEntries(undefined, context);
  console.log(`[Lane] tipId(before)=${tipBefore ?? "null"} entries(before)=${entriesBefore.length}`);
  for (const entry of [...entriesBefore].sort((a, b) => a.seq - b.seq)) {
    const detail = entry.type === "message" ? ` role=${entry.message.role}` : entry.type === "compaction" ? ` tokensBefore=${entry.tokensBefore} retainedTail=${entry.retainedTail.length}` : "";
    console.log(
      `[Entry][before] seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} type=${entry.type}${detail}`,
    );
  }

  if (inspect) {
    await harness.close(context);
    await repo.close(context);
    return;
  }

  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));
  const detachContext = attachContextTokenHook(harness, sessionId, (line) => console.log(line));

  let failed = false;
  if (compact) {
    console.log(
      `[User][${sessionId}] (manual compaction)${customInstructions ? ` customInstructions="${customInstructions}"` : ""}`,
    );
    const result = await lane.compact(customInstructions ? { customInstructions } : undefined, context);
    failed = logCompactionResult(result);
  } else {
    console.log(`[User][${sessionId}] ${prompt}`);
    const result = await lane.prompt(prompt as string, undefined, context);
    failed = logRunResult("Operation", result);
  }

  detachContext();
  detachTrace();

  const tipAfter = await lane.getTipId(context);
  const entriesAfter = await lane.findEntries(undefined, context);
  console.log(`[Lane] tipId(after)=${tipAfter ?? "null"} entries(after)=${entriesAfter.length}`);
  for (const entry of [...entriesAfter].sort((a, b) => a.seq - b.seq)) {
    const detail = entry.type === "message" ? ` role=${entry.message.role}` : entry.type === "compaction" ? ` tokensBefore=${entry.tokensBefore} retainedTail=${entry.retainedTail.length}` : "";
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
