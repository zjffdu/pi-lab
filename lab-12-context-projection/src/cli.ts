import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { RunResult } from "@earendil-works/pi-agent-core";

import { appendCaseNoteEntry, type CaseNoteData, type CaseNoteVisibility } from "./case-note-entries.js";
import { openMainLane } from "./create-harness.js";
import { attachHarnessTraceLogger, attachProjectedContextLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "./session-store.js";

/** Fixed grouping key, same role as earlier labs' `SESSION_GROUP` — see `openOrCreateSession`. */
const SESSION_GROUP = "lab-12-context-projection";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface AddNoteArgs {
  bookingNo: string;
  visibility: CaseNoteVisibility;
  text: string;
  internalOnly: string | undefined;
}

interface CliArgs {
  sessionId: string;
  prompt: string | undefined;
  addNote: AddNoteArgs | undefined;
  withProjection: boolean;
  inspect: boolean;
}

function parseVisibility(raw: string): CaseNoteVisibility {
  if (raw !== "shared" && raw !== "internal") {
    throw new Error(`--add-note's visibility must be "shared" or "internal", got "${raw}".`);
  }
  return raw;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let addNote: AddNoteArgs | undefined;
  let withProjection = false;
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
    } else if (flag === "--add-note") {
      const bookingNo = argv[index + 1];
      const visibilityRaw = argv[index + 2];
      const text = argv[index + 3];
      if (bookingNo === undefined || visibilityRaw === undefined || text === undefined) {
        throw new Error('--add-note requires: <bookingNo> <shared|internal> "<text>"');
      }
      addNote = { bookingNo, visibility: parseVisibility(visibilityRaw), text, internalOnly: undefined };
      index += 4;
    } else if (flag === "--internal-only") {
      if (addNote === undefined) {
        throw new Error("--internal-only must follow --add-note.");
      }
      addNote = { ...addNote, internalOnly: argv[index + 1] };
      index += 2;
    } else if (flag === "--with-projection") {
      withProjection = true;
      index += 1;
    } else if (flag === "--inspect") {
      inspect = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".`);
    }
  }

  if (!sessionId) {
    throw new Error(
      'Usage: npm run agent -- --session <id> [--with-projection] --prompt "<text>"\n' +
        '   or: npm run agent -- --session <id> --add-note <bookingNo> <shared|internal> "<text>" ' +
        '[--internal-only "<text>"]\n' +
        "   or: npm run agent -- --session <id> --inspect\n" +
        "One CLI invocation is one turn, one durable case-note write, or one read-only " +
        "inspection. --with-projection only affects --prompt: it decides whether this " +
        "invocation's harness has entry-projectors.ts's projector wired at all.",
    );
  }
  const modeCount = [Boolean(prompt), Boolean(addNote), inspect].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Exactly one of --prompt, --add-note, or --inspect is required.");
  }

  return { sessionId, prompt, addNote, withProjection, inspect };
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

async function main(): Promise<void> {
  const { sessionId, prompt, addNote, withProjection, inspect } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session, created } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);

  console.log(
    `[Session] id=${session.metadata.id} ${created ? "created" : "reopened"} path=${session.metadata.path}`,
  );

  const { harness, lane, open } = await openMainLane(session, context, { withCaseNoteProjection: withProjection });
  console.log(
    `[Harness] lane=main openOperationsOnAttach=${open.length} withCaseNoteProjection=${withProjection}`,
  );

  async function printEntries(when: "before" | "after"): Promise<void> {
    const allEntries = await session.findEntries({ order: "asc" }, context);
    console.log(`[Entries][${when}] total=${allEntries.length}`);
    for (const entry of allEntries) {
      const customType = entry.type === "custom" ? ` customType=${entry.customType}` : "";
      const noteVisibility =
        entry.type === "custom" && entry.customType === "case_note" && typeof entry.data === "object" && entry.data !== null
          ? ` visibility=${(entry.data as Record<string, unknown>).visibility}`
          : "";
      console.log(`  seq=${entry.seq} id=${entry.id} parent=${entry.parentId ?? "null"} type=${entry.type}${customType}${noteVisibility}`);
    }
  }

  await printEntries("before");

  if (inspect) {
    await harness.close(context);
    await repo.close(context);
    return;
  }

  if (addNote !== undefined) {
    const note: CaseNoteData = {
      noteId: `CN-cli-${Date.now()}`,
      bookingNo: addNote.bookingNo,
      author: "cli-operator",
      visibility: addNote.visibility,
      text: addNote.text,
      internalOnly: addNote.internalOnly,
    };
    const entryId = await appendCaseNoteEntry(lane, note, context);
    console.log(`[CaseNote][${sessionId}] appended entryId=${entryId} visibility=${note.visibility}`);
    await printEntries("after");
    await harness.close(context);
    await repo.close(context);
    return;
  }

  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));
  const detachContextLog = attachProjectedContextLogger(harness, sessionId, (line) => console.log(line));

  console.log(`[User][${sessionId}] ${prompt}`);
  const result = await lane.prompt(prompt as string, undefined, context);
  const failed = logRunResult("Operation", result);

  detachContextLog();
  detachTrace();

  await printEntries("after");

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
