import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { modelSelectionFromEnvironment, openRootConversation } from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { describeEntry, listEntries } from "./transcript.js";

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
  const selection = modelSelectionFromEnvironment();
  const models = builtinModels();

  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  console.log(`[Session] id=${sessionId} ${created ? "created" : "reopened"} path=${path}`);

  const { harness, root, inspection } = await openRootConversation(storage, { models, selection }, context);

  console.log(
    `[Harness] scheduling=${inspection.scheduling} unfinishedTasks=${inspection.tasks.length} ` +
      `unsettledSubmissions=${inspection.submissions.length}`,
  );
  for (const task of inspection.tasks) {
    console.log(`[Harness] UNFINISHED task=${task.record.id} state=${task.state.kind}`);
  }

  const before = await listEntries(root, context);
  console.log(
    `[Conversation] root=${root.id} entries(before)=${before.length} ` +
      `newestEntry(before)=${before.at(-1)?.id ?? "none"}`,
  );

  const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);

  const submission = await root.submit({ type: "input", content: prompt }, context);
  const settled = await submission.wait(context);

  await trace.settled(settled.id);
  await trace.stop();

  console.log(
    `[Submission] id=${settled.id} status=${settled.status} entry=${settled.entry}` +
      `${"answer" in settled && settled.answer !== undefined ? ` answer=${settled.answer}` : ""}`,
  );

  const after = await listEntries(root, context);
  console.log(
    `[Conversation] entries(after)=${after.length} newestEntry(after)=${after.at(-1)?.id ?? "none"}`,
  );
  for (const entry of after) {
    console.log(`[Entry] ${describeEntry(entry)}`);
  }

  await harness.close(context);

  if (settled.status !== "done") {
    console.error(`[Fatal] submission ${settled.id} ended ${settled.status}: ${JSON.stringify(settled)}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
