import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { HarnessInspection, SubmissionId } from "@earendil-works/pi-durable";

import { modelSelectionFromEnvironment, openRootConversation } from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { describeEntry, listEntries } from "./transcript.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface CliArgs {
  sessionId: string;
  prompt: string | undefined;
  resume: boolean;
  /** Also wait on the newest already-settled submission, to read back its stored record. */
  settled: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let resume = false;
  let settled = false;

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
    } else if (flag === "--settled") {
      settled = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".`);
    }
  }

  if (!sessionId) {
    throw new Error(
      'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
        "   or: npm run agent -- --session <id> --resume [--settled]\n" +
        "One CLI invocation is one turn or one resume attempt against one named session.",
    );
  }
  if (resume && prompt) {
    throw new Error("--resume and --prompt are mutually exclusive: a resume attempt sends no new prompt.");
  }
  if (!resume && !prompt) {
    throw new Error('Either --prompt "<text>" or --resume is required.');
  }

  if (settled && !resume) {
    throw new Error("--settled is only meaningful with --resume.");
  }

  return { sessionId, prompt, resume, settled };
}

function printInspection(inspection: HarnessInspection): void {
  console.log(
    `[Harness] scheduling=${inspection.scheduling} unfinishedTasks=${inspection.tasks.length} ` +
      `unsettledSubmissions=${inspection.submissions.length}`,
  );
  for (const task of inspection.tasks) {
    const checkpoint = task.record.state.status === "terminal" ? undefined : task.record.state.checkpoint;
    const phase = checkpoint && typeof checkpoint === "object" && "phase" in checkpoint ? checkpoint.phase : "none";
    console.log(
      `[Harness] UNFINISHED task=${task.record.id} kind=${task.record.kind} status=${task.record.state.status} ` +
        `phase=${String(phase)} scheduler=${task.state.kind}`,
    );
  }
  for (const submission of inspection.submissions) {
    console.log(
      `[Harness] UNSETTLED submission=${submission.id} status=${submission.status} ` +
        `entry=${"entry" in submission && submission.entry ? submission.entry : "none"}`,
    );
  }
}

async function main(): Promise<void> {
  const { sessionId, prompt, resume, settled: rereadSettled } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;
  const selection = modelSelectionFromEnvironment();
  const models = builtinModels();

  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  console.log(`[Session] id=${sessionId} ${created ? "created" : "reopened"} path=${path}`);

  // `inspect()` runs inside openRootConversation, before anything that enables scheduling
  // (`submit`, `wait`, `resume`): it is a read of what the previous process left behind.
  const { harness, root, inspection } = await openRootConversation(storage, { models, selection }, context);
  printInspection(inspection);

  const before = await listEntries(root, context);
  console.log(
    `[Conversation] root=${root.id} entries(before)=${before.length} ` +
      `newestEntry(before)=${before.at(-1)?.id ?? "none"}`,
  );
  for (const entry of before) {
    console.log(`[Entry][before] ${describeEntry(entry)}`);
  }

  let failed = false;
  const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);

  if (resume) {
    const targets = new Set<SubmissionId>(inspection.submissions.map((record) => record.id));
    if (rereadSettled) {
      // A settled submission is a stored record: waiting on it returns that record again and runs nothing.
      const newestDone = await storage.scanSubmissions(
        { conversationId: root.id, status: "done", order: "descending" },
        1,
        undefined,
        context,
      );
      for (const record of newestDone.items) {
        targets.add(record.id);
      }
    }
    console.log(`[Resume][${sessionId}] reacquiring ${targets.size} submission(s)`);
    harness.resume();
    for (const id of targets) {
      const submission = await harness.submission(id, context);
      if (!submission) {
        throw new Error(`submission ${id} cannot be reacquired`);
      }
      const settled = await submission.wait(context);
      // Only a submission that was unsettled at attach produces a terminal event on the stream; an
      // already-settled one is read back from storage and nothing more is committed for it.
      if (inspection.submissions.some((record) => record.id === id)) {
        await trace.settled(settled.id);
      }
      console.log(
        `[Resume] submission=${settled.id} status=${settled.status} entry=${settled.entry}` +
          `${"answer" in settled && settled.answer !== undefined ? ` answer=${settled.answer}` : ""}`,
      );
      failed ||= settled.status !== "done";
    }
    if (targets.size === 0) {
      console.log(
        inspection.tasks.length === 0
          ? "[Resume] nothing to resume: no unsettled submission and no unfinished task"
          : "[Resume] no unsettled submission to wait for, but unfinished tasks were found (see above)",
      );
    }
  } else {
    console.log(`[User][${sessionId}] ${prompt}`);
    const submission = await root.submit({ type: "input", content: prompt as string }, context);
    console.log(`[Submission] admitted id=${submission.id}`);
    const settled = await submission.wait(context);
    await trace.settled(settled.id);
    console.log(
      `[Submission] id=${settled.id} status=${settled.status} entry=${settled.entry}` +
        `${"answer" in settled && settled.answer !== undefined ? ` answer=${settled.answer}` : ""}`,
    );
    failed = settled.status !== "done";
  }

  await trace.stop();

  const after = await listEntries(root, context);
  console.log(
    `[Conversation] entries(after)=${after.length} newestEntry(after)=${after.at(-1)?.id ?? "none"}`,
  );
  for (const entry of after) {
    console.log(`[Entry][after] ${describeEntry(entry)}`);
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
