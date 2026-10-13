import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { caseNoteEvidence, forbidInternalOnlyValues } from "./case-note-evidence.js";
import {
  appendCaseNote,
  type CaseNoteData,
  type CaseNoteVisibility,
  type CaseNoteWritePolicy,
} from "./case-note-entries.js";
import { createBookingRegistry, modelSelectionFromEnvironment, openHarness } from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { createProviderBoundary } from "./provider-boundary.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { listEntries, summarizeEntry } from "./transcript.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface AddNote {
  bookingNo: string;
  visibility: CaseNoteVisibility;
  text: string;
  internalOnly: string | undefined;
  policy: CaseNoteWritePolicy;
}

type Mode = { kind: "prompt"; prompt: string } | { kind: "add-note"; note: AddNote } | { kind: "inspect" };

const USAGE =
  'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
  '   or: npm run agent -- --session <id> --add-note <bookingNo> <shared|internal> "<text>" ' +
  '[--internal-only "<text>"] [--durable-only]\n' +
  "   or: npm run agent -- --session <id> --inspect\n" +
  "One CLI invocation is one turn, one durable case-note write, or one read-only inspection. " +
  "--durable-only writes the note without its model message, so it never reaches the model.";

function parseArgs(argv: string[]): { sessionId: string; mode: Mode } {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let addNote: AddNote | undefined;
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
      const visibility = argv[index + 2];
      const text = argv[index + 3];
      if (bookingNo === undefined || text === undefined || (visibility !== "shared" && visibility !== "internal")) {
        throw new Error(`--add-note needs <bookingNo> <shared|internal> "<text>".\n${USAGE}`);
      }
      addNote = { bookingNo, visibility, text, internalOnly: undefined, policy: "projected" };
      index += 4;
    } else if (flag === "--internal-only" || flag === "--durable-only") {
      if (addNote === undefined) {
        throw new Error(`${flag} must follow --add-note.\n${USAGE}`);
      }
      if (flag === "--internal-only") {
        addNote = { ...addNote, internalOnly: argv[index + 1] };
        index += 2;
      } else {
        addNote = { ...addNote, policy: "durable-only" };
        index += 1;
      }
    } else if (flag === "--inspect") {
      inspect = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".\n${USAGE}`);
    }
  }

  if (!sessionId) {
    throw new Error(USAGE);
  }
  const modes: Mode[] = [
    ...(prompt ? [{ kind: "prompt", prompt } as const] : []),
    ...(addNote ? [{ kind: "add-note", note: addNote } as const] : []),
    ...(inspect ? [{ kind: "inspect" } as const] : []),
  ];
  const [mode, ...extra] = modes;
  if (mode === undefined || extra.length > 0) {
    throw new Error(`Exactly one of --prompt, --add-note, or --inspect is required.\n${USAGE}`);
  }
  return { sessionId, mode };
}

async function main(): Promise<void> {
  const { sessionId, mode } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;
  const models = builtinModels();

  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  console.log(`[Session] id=${sessionId} ${created ? "created" : "reopened"} path=${path}`);

  const boundary = createProviderBoundary({
    onRequest: (request) =>
      console.log(`[Request] #${request.index} messages=${request.messageCount} roles=[${request.roles.join(", ")}]`),
  });
  const { harness, root, inspection } = await openHarness(
    storage,
    { models, selection: modelSelectionFromEnvironment(), registry: createBookingRegistry({ boundary }) },
    context,
  );
  console.log(
    `[Harness] unfinishedTasks=${inspection.tasks.length} unsettledSubmissions=${inspection.submissions.length}`,
  );

  // Every internalOnly value in the durable session is a text that must never reach the provider. Only the
  // count is printed.
  const armed = await forbidInternalOnlyValues(root, boundary, context);
  console.log(`[Boundary] forbidden texts armed from durable case notes: ${armed}`);

  async function printState(): Promise<void> {
    const entries = await listEntries(root, context);
    const evidence = new Map((await caseNoteEvidence(root, context)).map((row) => [row.entryId, row]));
    console.log(`[Entries] total=${entries.length}`);
    for (const entry of entries) {
      const row = evidence.get(entry.id);
      console.log(
        row
          ? `  ${entry.id} ${entry.kind} ${row.noteId} visibility=${row.visibility} ` +
              `stored=${row.storedModelMessages} contributes=${row.contributedMessages}`
          : `  ${entry.id} ${summarizeEntry(entry)}`,
      );
    }
    const view = await root.context(context);
    console.log(`[Context] the next request would carry ${view.messages.length} message(s): ${view.messages.map((m) => m.role).join(", ")}`);
  }

  let failed = false;
  switch (mode.kind) {
    case "inspect":
      await printState();
      break;
    case "add-note": {
      const note: CaseNoteData = {
        noteId: `CN-cli-${Date.now()}`,
        bookingNo: mode.note.bookingNo,
        author: "cli-operator",
        visibility: mode.note.visibility,
        text: mode.note.text,
        ...(mode.note.internalOnly === undefined ? {} : { internalOnly: mode.note.internalOnly }),
      };
      const entry = await appendCaseNote(root, note, mode.note.policy, context);
      console.log(
        `[CaseNote] entry=${entry.id} ${note.noteId} visibility=${note.visibility} policy=${mode.note.policy} ` +
          `storedModelMessages=${entry.model?.length ?? 0}`,
      );
      await printState();
      break;
    }
    case "prompt": {
      const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);
      console.log(`[User] ${mode.prompt}`);
      const settled = await (await root.submit({ type: "input", content: mode.prompt }, context)).wait(context);
      await trace.settled(settled.id);
      await trace.stop();
      console.log(`[Submission] id=${settled.id} status=${settled.status}`);
      console.log(`[Boundary] requests=${boundary.requests.length} violations=${boundary.violations.length}`);
      failed = settled.status !== "done" || boundary.violations.length > 0;
      break;
    }
  }

  await harness.close(context);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
