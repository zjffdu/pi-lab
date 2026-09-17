import "dotenv/config";

import { fileURLToPath } from "node:url";

import { openMainLane } from "./create-harness.js";
import { attachHarnessTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "./session-store.js";

/**
 * Fixed grouping key for every session this lab creates — see `openOrCreateSession` for
 * why this must stay the same string across every CLI invocation, in every process, no
 * matter which shell directory `npm run agent` happens to be started from.
 */
const SESSION_GROUP = "lab-07-durable-harness-session";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface CliArgs {
  sessionId: string;
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else {
      throw new Error(`Unknown argument "${flag}". Expected --session <id> --prompt "<text>".`);
    }
  }

  if (!sessionId || !prompt) {
    throw new Error(
      'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
        "Both --session and --prompt are required. One CLI invocation is one turn: run the " +
        "command again, in a new process, to send a follow-up in the same session.",
    );
  }

  return { sessionId, prompt };
}

async function main(): Promise<void> {
  const { sessionId, prompt } = parseArgs(process.argv.slice(2));
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
        `kind=${operation.kind} startedAt=${operation.startedAt}`,
    );
  }

  const tipBefore = await lane.getTipId(context);
  console.log(`[Lane] tipId(before)=${tipBefore ?? "null"}`);

  const detachLogger = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));

  console.log(`[User][${sessionId}] ${prompt}`);
  const result = await lane.prompt(prompt, undefined, context);

  detachLogger();

  let failed = false;
  if (!result.ok) {
    failed = true;
    console.error(`[Fatal] lane.prompt rejected: ${result.error._tag}: ${result.error.message}`);
  } else if (result.value.status === "suspended") {
    console.log(
      `[Operation] operationId=${result.value.operationId} status=suspended ` +
        "(deferred provider response — not expected by this lab's synchronous tool)",
    );
  } else {
    const record = result.value;
    console.log(
      `[Operation] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
        `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"} ` +
        `startedAt=${record.startedAt} endedAt=${record.endedAt}`,
    );
    if (record.status !== "completed") {
      failed = true;
      if (record.error) {
        console.error(`[Fatal] operation ${record.status}: ${record.error.code}: ${record.error.message}`);
      }
    }
  }

  const tipAfter = await lane.getTipId(context);
  console.log(`[Lane] tipId(after)=${tipAfter ?? "null"}`);

  const entries = await lane.findEntries(undefined, context);
  console.log(`[Lane] entries=${entries.length}`);
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    let detail = "";
    if (entry.type === "message") {
      detail = ` role=${entry.message.role}`;
      if (entry.message.role === "toolResult") {
        detail += ` toolCallId=${entry.message.toolCallId}`;
      }
    }
    console.log(
      `[Entry] seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} type=${entry.type}${detail}`,
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
