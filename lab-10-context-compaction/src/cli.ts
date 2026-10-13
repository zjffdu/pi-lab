import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CompactionPolicy } from "@earendil-works/pi-durable";

import {
  compactConversation,
  compactionEntries,
  compactionSummaryText,
  estimatedContextTokens,
  keepRecentTokensForLastTurns,
} from "./compaction.js";
import { compactionPolicyFromEnvironment, modelSelectionFromEnvironment, openRootConversation } from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { describeEntry, listEntries } from "./transcript.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

type Mode =
  | { kind: "prompt"; prompt: string }
  | { kind: "compact"; customInstructions: string | undefined; keepTurns: number | undefined }
  | { kind: "inspect" };

interface CliArgs {
  sessionId: string;
  mode: Mode;
}

const USAGE =
  'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
  '   or: npm run agent -- --session <id> --compact [--custom-instructions "<text>"] [--keep-turns <n>]\n' +
  "   or: npm run agent -- --session <id> --inspect\n" +
  "One CLI invocation is one turn, one compaction, or one read-only inspection.";

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let compact = false;
  let customInstructions: string | undefined;
  let keepTurns: number | undefined;
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
    } else if (flag === "--keep-turns") {
      keepTurns = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 2;
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
  if ([Boolean(prompt), compact, inspect].filter(Boolean).length !== 1) {
    throw new Error(`Exactly one of --prompt, --compact, or --inspect is required.\n${USAGE}`);
  }
  if ((customInstructions !== undefined || keepTurns !== undefined) && !compact) {
    throw new Error("--custom-instructions and --keep-turns only apply to --compact.");
  }
  if (keepTurns !== undefined && !(Number.isSafeInteger(keepTurns) && keepTurns > 0)) {
    throw new Error("--keep-turns must be a positive integer.");
  }

  if (prompt) {
    return { sessionId, mode: { kind: "prompt", prompt } };
  }
  return { sessionId, mode: compact ? { kind: "compact", customInstructions, keepTurns } : { kind: "inspect" } };
}

async function main(): Promise<void> {
  const { sessionId, mode } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;
  const models = builtinModels();

  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  console.log(`[Session] id=${sessionId} ${created ? "created" : "reopened"} path=${path}`);

  // The harness reads this object on every resolution, so --keep-turns can adjust it after the
  // transcript has been read, without reopening the session.
  const compaction: Partial<CompactionPolicy> = compactionPolicyFromEnvironment();
  const { harness, root, inspection } = await openRootConversation(
    storage,
    { models, selection: modelSelectionFromEnvironment(), compaction },
    context,
  );
  console.log(
    `[Harness] unfinishedTasks=${inspection.tasks.length} unsettledSubmissions=${inspection.submissions.length}`,
  );

  const before = await listEntries(root, context);
  const viewBefore = await root.context(context);
  console.log(
    `[Conversation] root=${root.id} entries(before)=${before.length} head=${viewBefore.head?.id ?? "none"} ` +
      `contextMessages=${viewBefore.messages.length} estimatedContextTokens=${estimatedContextTokens(viewBefore)}`,
  );

  let failed = false;
  if (mode.kind !== "inspect") {
    const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);

    if (mode.kind === "prompt") {
      console.log(`[User][${sessionId}] ${mode.prompt}`);
      const submission = await root.submit({ type: "input", content: mode.prompt }, context);
      const settled = await submission.wait(context);
      await trace.settled(settled.id);
      console.log(`[Submission] id=${settled.id} status=${settled.status}`);
      failed = settled.status !== "done";
    } else {
      if (mode.keepTurns !== undefined) {
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(viewBefore, mode.keepTurns);
        console.log(
          `[Compaction] keepRecentTokens=${compaction.keepRecentTokens} (computed to keep the last ${mode.keepTurns} turns)`,
        );
      } else {
        console.log(`[Compaction] keepRecentTokens=${compaction.keepRecentTokens} (from COMPACT_KEEP_RECENT_TOKENS)`);
      }
      console.log(`[User][${sessionId}] (manual compaction)${mode.customInstructions ? ` instructions="${mode.customInstructions}"` : ""}`);
      const outcome = await compactConversation(harness, root, mode.customInstructions, context);
      console.log(`[Compact] ${JSON.stringify(outcome)}`);
      failed = outcome.kind === "task_failed" || outcome.kind === "not_placed";
    }

    await trace.stop();
  }

  const after = await listEntries(root, context);
  const viewAfter = await root.context(context);
  console.log(
    `[Conversation] entries(after)=${after.length} head=${viewAfter.head?.id ?? "none"} ` +
      `contextMessages=${viewAfter.messages.length} estimatedContextTokens=${estimatedContextTokens(viewAfter)}`,
  );
  for (const entry of after) {
    console.log(`[Entry] ${describeEntry(entry)}${entry.head !== undefined ? ` head=${entry.head}` : ""}`);
  }
  for (const entry of compactionEntries(after)) {
    console.log(`[Summary] entry=${entry.id} ${compactionSummaryText(entry)}`);
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
