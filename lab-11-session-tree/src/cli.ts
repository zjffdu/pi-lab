import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";

import { forkAt, loadBranches } from "./branches.js";
import { modelSelectionFromEnvironment, openHarness } from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { readLabels, setLabel } from "./labels.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { summarizeEntry } from "./transcript.js";
import { branchTips, describeFork, renderTree } from "./tree-view.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

type Mode =
  | { kind: "prompt"; prompt: string }
  | { kind: "fork"; at: EntryId }
  | { kind: "label"; entryId: EntryId; label: string | undefined }
  | { kind: "preview"; at: EntryId }
  | { kind: "inspect" };

interface CliArgs {
  sessionId: string;
  /** The conversation a prompt, fork, or preview addresses; the root when omitted. */
  conversationId: ConversationId | undefined;
  mode: Mode;
}

const USAGE =
  'Usage: npm run agent -- --session <id> --prompt "<text>" [--conversation <id>]\n' +
  "   or: npm run agent -- --session <id> --fork <entryId> [--conversation <id>]\n" +
  '   or: npm run agent -- --session <id> --label <entryId> "<text>"      (empty text clears the label)\n' +
  "   or: npm run agent -- --session <id> --preview <entryId> [--conversation <id>]\n" +
  "   or: npm run agent -- --session <id> --inspect\n" +
  "One CLI invocation is one turn, one fork, one label write, one preview, or one read-only inspection.";

function parseId<T>(raw: string | undefined, flag: string): T {
  const parsed = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} needs a positive integer id, got "${raw ?? ""}".\n${USAGE}`);
  }
  return parsed as T;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let conversationId: ConversationId | undefined;
  let prompt: string | undefined;
  let forkAtEntry: EntryId | undefined;
  let label: { entryId: EntryId; text: string } | undefined;
  let previewAt: EntryId | undefined;
  let inspect = false;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--conversation") {
      conversationId = parseId<ConversationId>(argv[index + 1], "--conversation");
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else if (flag === "--fork") {
      forkAtEntry = parseId<EntryId>(argv[index + 1], "--fork");
      index += 2;
    } else if (flag === "--label") {
      label = { entryId: parseId<EntryId>(argv[index + 1], "--label"), text: argv[index + 2] ?? "" };
      index += 3;
    } else if (flag === "--preview") {
      previewAt = parseId<EntryId>(argv[index + 1], "--preview");
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
  const modes: Mode[] = [
    ...(prompt ? [{ kind: "prompt", prompt } as const] : []),
    ...(forkAtEntry !== undefined ? [{ kind: "fork", at: forkAtEntry } as const] : []),
    ...(label ? [{ kind: "label", entryId: label.entryId, label: label.text === "" ? undefined : label.text } as const] : []),
    ...(previewAt !== undefined ? [{ kind: "preview", at: previewAt } as const] : []),
    ...(inspect ? [{ kind: "inspect" } as const] : []),
  ];
  const [mode, ...extra] = modes;
  if (mode === undefined || extra.length > 0) {
    throw new Error(`Exactly one of --prompt, --fork, --label, --preview, or --inspect is required.\n${USAGE}`);
  }
  if (conversationId !== undefined && !["prompt", "fork", "preview"].includes(mode.kind)) {
    throw new Error("--conversation only applies to --prompt, --fork, and --preview.");
  }

  return { sessionId, conversationId, mode };
}

async function main(): Promise<void> {
  const { sessionId, conversationId, mode } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;
  const models = builtinModels();

  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  console.log(`[Session] id=${sessionId} ${created ? "created" : "reopened"} path=${path}`);

  const { harness, root, inspection } = await openHarness(
    storage,
    { models, selection: modelSelectionFromEnvironment() },
    context,
  );
  console.log(
    `[Harness] unfinishedTasks=${inspection.tasks.length} unsettledSubmissions=${inspection.submissions.length}`,
  );

  const target = conversationId === undefined ? root : await harness.conversation(conversationId, context);
  if (target === undefined) {
    throw new Error(`No conversation ${conversationId} in session ${sessionId}. Run --inspect to list them.`);
  }

  async function printTree(when: "before" | "after"): Promise<void> {
    const branches = await loadBranches(harness, storage, context);
    const tips = branchTips(branches)
      .map((tip) => `c${tip.conversationId}:${tip.entryId ?? "none"}`)
      .join(" ");
    console.log(`[Tree][${when}] conversations=${branches.length} tips=${tips}`);
    console.log(renderTree(branches, { labels: await readLabels(harness, context), selected: target?.id }));
  }

  await printTree("before");

  let failed = false;
  switch (mode.kind) {
    case "inspect":
      break;
    case "prompt": {
      const trace = await attachTraceLogger(harness, target.id, (line) => console.log(line), context, {
        tag: `c${target.id}`,
      });
      console.log(`[User][c${target.id}] ${mode.prompt}`);
      const submission = await target.submit({ type: "input", content: mode.prompt }, context);
      const settled = await submission.wait(context);
      await trace.settled(settled.id);
      await trace.stop();
      console.log(`[Submission] id=${settled.id} status=${settled.status}`);
      failed = settled.status !== "done";
      break;
    }
    case "fork": {
      const fork = await forkAt(target, mode.at, context);
      const record = (await loadBranches(harness, storage, context)).find((branch) => branch.record.id === fork.id)?.record;
      console.log(`[Fork] ${record ? describeFork(record) : `conversation ${fork.id}`}`);
      break;
    }
    case "label":
      await setLabel(harness, storage, mode.entryId, mode.label, context);
      console.log(`[Label] entry ${mode.entryId} ${mode.label === undefined ? "cleared" : `= "${mode.label}"`}`);
      break;
    case "preview": {
      const view = await target.context(context, { at: mode.at });
      console.log(
        `[Preview] a fork of c${target.id} at entry ${mode.at} would start with ${view.entries.length} entries ` +
          `and send ${view.messages.length} messages: ${view.messages.map((message) => message.role).join(", ")}`,
      );
      for (const entry of view.entries) {
        console.log(`[Preview]   ${entry.id} ${summarizeEntry(entry)}`);
      }
      break;
    }
  }

  if (mode.kind !== "inspect" && mode.kind !== "preview") {
    await printTree("after");
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
