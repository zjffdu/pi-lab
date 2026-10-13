import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Conversation, Harness, Storage } from "@earendil-works/pi-durable";

import { forkAt, listConversationRecords, loadBranches } from "../src/branches.js";
import { modelSelectionFromEnvironment, openHarness } from "../src/create-harness.js";
import { attachTraceLogger, type TraceHandle } from "../src/harness-trace-logger.js";
import { readLabels, setLabel } from "../src/labels.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { entryText, listEntries } from "../src/transcript.js";
import { branchTips, describeFork, inheritedEntries, ownEntries, renderTree } from "../src/tree-view.js";

const ctx = BACKGROUND_CONTEXT;
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const SESSION_ID = `session-tree-${Date.now()}`;
const BRANCH_POINT_LABEL = "after-bk1001-lookup";

const SEED_PROMPTS = [
  "Look up booking BK1001 and tell me its route, vessel, and containers.",
  "Check the container movement events for every container of BK1001 and summarize them in one sentence.",
  "Given what you know so far, is this booking on schedule or at risk? Answer in one sentence.",
] as const;
const CHANGED_PREMISE =
  "Actually, I made an error — the booking we should be discussing is BK1002, not BK1001. Look it up and tell me its route, vessel, and containers.";
const CONTRAST_QUESTION =
  "Which vessel is the booking we are currently discussing on, and which container numbers does it have? Answer in one short sentence.";
const AFTER_RESTART_QUESTION = "In one short sentence, what is the origin port of the booking we are currently discussing?";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function lastAnswer(conversation: Conversation): Promise<string> {
  const assistant = (await listEntries(conversation, ctx)).filter((entry) => entry.kind === "pi.assistant").at(-1);
  return assistant === undefined ? "" : entryText(assistant);
}

interface Process {
  harness: Harness;
  storage: Storage;
  root: Conversation;
  traces: Map<number, TraceHandle>;
}

async function openProcess(): Promise<Process> {
  const { storage, created } = await openSessionStorage(SESSIONS_ROOT, SESSION_ID, ctx);
  const { harness, root } = await openHarness(
    storage,
    { models: builtinModels(), selection: modelSelectionFromEnvironment() },
    ctx,
  );
  console.log(`[Session] ${created ? "created" : "reopened"} ${SESSION_ID}`);
  return { harness, storage, root, traces: new Map() };
}

async function trace(process: Process, conversation: Conversation): Promise<void> {
  process.traces.set(
    conversation.id,
    await attachTraceLogger(process.harness, conversation.id, (line) => console.log(line), ctx, { tag: `c${conversation.id}` }),
  );
}

async function ask(process: Process, conversation: Conversation, prompt: string): Promise<string> {
  console.log(`\n[User][c${conversation.id}] ${prompt}`);
  const settled = await (await conversation.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
  await process.traces.get(conversation.id)?.settled(settled.id);
  assert(settled.status === "done", `a turn in c${conversation.id} must finish: ${settled.status}`);
  return lastAnswer(conversation);
}

async function closeProcess(process: Process): Promise<void> {
  for (const handle of process.traces.values()) {
    await handle.stop();
  }
  await process.harness.close(ctx);
}

async function printTree(process: Process, title: string): Promise<void> {
  const branches = await loadBranches(process.harness, process.storage, ctx);
  const tips = branchTips(branches).map((tip) => `c${tip.conversationId}:${tip.entryId ?? "none"}`).join(" ");
  console.log(`\n[Tree] ${title}: conversations=${branches.length} tips=${tips}`);
  console.log(renderTree(branches, { labels: await readLabels(process.harness, ctx) }));
}

async function main(): Promise<void> {
  let proc = await openProcess();
  await trace(proc, proc.root);

  console.log("\n=== Step 1: one completed investigation on the root conversation (branch A) ===");
  for (const prompt of SEED_PROMPTS.slice(0, 1)) {
    await ask(proc, proc.root, prompt);
  }
  const afterLookup = (await listEntries(proc.root, ctx)).at(-1)!;
  await setLabel(proc.harness, proc.storage, afterLookup.id, BRANCH_POINT_LABEL, ctx);
  console.log(`[Label] entry ${afterLookup.id} = "${BRANCH_POINT_LABEL}"`);
  for (const prompt of SEED_PROMPTS.slice(1)) {
    await ask(proc, proc.root, prompt);
  }
  const rootBeforeFork = await listEntries(proc.root, ctx);
  await printTree(proc, "root only");

  console.log("\n=== Step 2: look at what a fork at the labeled entry would start with, without creating one ===");
  const preview = await proc.root.context(ctx, { at: afterLookup.id });
  console.log(
    `[Preview] context({ at: ${afterLookup.id} }): ${preview.entries.length} entries, messages: ` +
      preview.messages.map((message) => message.role).join(", "),
  );
  assert((await listConversationRecords(proc.storage, ctx)).length === 1, "a preview must not create a conversation");

  console.log("\n=== Step 3: fork at the labeled entry and continue with a changed premise (branch B) ===");
  const fork = await forkAt(proc.root, afterLookup.id, ctx);
  const forkRecord = (await listConversationRecords(proc.storage, ctx)).find((record) => record.id === fork.id)!;
  console.log(`[Fork] ${describeFork(forkRecord)}`);
  await trace(proc, fork);
  await ask(proc, fork, CHANGED_PREMISE);

  await printTree(proc, "after the fork continued");
  const branches = await loadBranches(proc.harness, proc.storage, ctx);
  const rootBranch = branches.find((branch) => branch.record.id === proc.root.id)!;
  const forkBranch = branches.find((branch) => branch.record.id === fork.id)!;
  assert(branches.length === 2 && branchTips(branches).length === 2, "the tree must have two conversations and two tips");
  assert(
    forkRecord.parent?.conversationId === proc.root.id && forkRecord.parent.at === afterLookup.id,
    "the fork's parent edge must name the root and the labeled entry",
  );
  assert(
    JSON.stringify(rootBranch.entries) === JSON.stringify(rootBeforeFork),
    "forking and continuing the fork must not change a single root entry",
  );
  assert(
    JSON.stringify(inheritedEntries(forkBranch).map((entry) => entry.id)) ===
      JSON.stringify(rootBeforeFork.filter((entry) => entry.id <= afterLookup.id).map((entry) => entry.id)),
    "the fork must inherit exactly the root's entries up to the fork point",
  );
  assert(ownEntries(forkBranch).length > 0, "the fork must have appended entries of its own");

  console.log("\n=== Step 4: the same question, asked in each branch ===");
  console.log(`[Question] ${CONTRAST_QUESTION}`);
  const answerRoot = await ask(proc, proc.root, CONTRAST_QUESTION);
  const answerFork = await ask(proc, fork, CONTRAST_QUESTION);
  const rootOwn = ["MAERSK TEST", "MSKU1234567", "MSKU2345678"];
  const forkOwn = ["MAERSK SECOND", "MSKU7654321"];
  console.table([
    { branch: `root c${proc.root.id} (BK1001)`, answer: answerRoot, ownFactsMissing: rootOwn.filter((fact) => !answerRoot.includes(fact)).length, otherFactsLeaked: forkOwn.filter((fact) => answerRoot.includes(fact)).length },
    { branch: `fork c${fork.id} (BK1002)`, answer: answerFork, ownFactsMissing: forkOwn.filter((fact) => !answerFork.includes(fact)).length, otherFactsLeaked: rootOwn.filter((fact) => answerFork.includes(fact)).length },
  ]);
  for (const fact of rootOwn) {
    assert(answerRoot.includes(fact), `root's answer must contain its own fact ${fact}: "${answerRoot}"`);
    assert(!answerFork.includes(fact), `fork's answer must not leak the root's fact ${fact}: "${answerFork}"`);
  }
  for (const fact of forkOwn) {
    assert(answerFork.includes(fact), `fork's answer must contain its own fact ${fact}: "${answerFork}"`);
    assert(!answerRoot.includes(fact), `root's answer must not leak the fork's fact ${fact}: "${answerRoot}"`);
  }

  console.log("\n=== Step 5: restart — a new process finds both branches and keeps working in the fork ===");
  const forkId = fork.id;
  const rootEntriesBeforeRestart = await listEntries(proc.root, ctx);
  await closeProcess(proc);

  proc = await openProcess();
  const records = await listConversationRecords(proc.storage, ctx);
  assert(records.length === 2, `both conversations must survive a restart, found ${records.length}`);
  assert(
    records.find((record) => record.id === forkId)?.parent?.at === afterLookup.id,
    "the fork's parent edge must survive a restart",
  );
  const reopenedFork = await proc.harness.conversation(forkId, ctx);
  assert(reopenedFork !== undefined, "the fork must be addressable by its id after a restart");
  await trace(proc, reopenedFork!);
  const answerAfterRestart = await ask(proc, reopenedFork!, AFTER_RESTART_QUESTION);
  assert(answerAfterRestart.includes("SGSIN"), `the reopened fork must still answer for BK1002 (SGSIN): "${answerAfterRestart}"`);
  assert(
    JSON.stringify(await listEntries(proc.root, ctx)) === JSON.stringify(rootEntriesBeforeRestart),
    "working in the reopened fork must not change the root",
  );

  await printTree(proc, "final");
  await closeProcess(proc);

  console.log("\n=== All Lab 11 session-tree assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
