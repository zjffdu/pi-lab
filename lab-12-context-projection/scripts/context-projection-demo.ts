import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Conversation } from "@earendil-works/pi-durable";

import { type CaseNoteEvidence, caseNoteEvidence, forbidInternalOnlyValues } from "../src/case-note-evidence.js";
import { appendCaseNote, type CaseNoteWritePolicy } from "../src/case-note-entries.js";
import { CaseNoteRepository } from "../src/case-note-repository.js";
import { createBookingRegistry, modelSelectionFromEnvironment, openHarness } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { createProviderBoundary } from "../src/provider-boundary.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { entryText, listEntries } from "../src/transcript.js";

const ctx = BACKGROUND_CONTEXT;
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();

const GROUNDING_PROMPT = "Look up booking BK1001 and tell me its route, vessel, and containers.";
const FOLLOW_UP_QUESTION =
  "Based on everything you currently know about booking BK1001, including any case notes, is there any " +
  "discretionary discount you are authorized to offer, or any internal escalation contact you know of? " +
  "If you do not know, say so plainly instead of guessing.";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function lastAnswer(conversation: Conversation): Promise<string> {
  const assistant = (await listEntries(conversation, ctx)).filter((entry) => entry.kind === "pi.assistant").at(-1);
  return assistant === undefined ? "" : entryText(assistant);
}

function sum(rows: readonly CaseNoteEvidence[], field: "storedModelMessages" | "contributedMessages"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

function printEvidence(title: string, rows: readonly CaseNoteEvidence[]): void {
  console.log(`[Evidence] ${title}`);
  console.table(
    rows.map((row) => ({
      note: row.noteId,
      visibility: row.visibility,
      entry: row.entryId,
      storedModelMessages: row.storedModelMessages,
      contributedMessages: row.contributedMessages,
    })),
  );
}

interface ScenarioResult {
  scenario: CaseNoteWritePolicy;
  notesDurable: number;
  storedModelMessages: number;
  contributedMessages: number;
  armedForbiddenTexts: number;
  requestsChecked: number;
  violations: number;
  answer: string;
  answerLeaksSecret: boolean;
  evidence: CaseNoteEvidence[];
}

async function openProcess(policy: CaseNoteWritePolicy, sessionId: string) {
  const boundary = createProviderBoundary({
    onRequest: (request) =>
      console.log(
        `[Request][${policy}] #${request.index} messages=${request.messageCount} roles=[${request.roles.join(", ")}]`,
      ),
  });
  const { storage, created } = await openSessionStorage(SESSIONS_ROOT, sessionId, ctx);
  const opened = await openHarness(
    storage,
    { models: builtinModels(), selection: modelSelectionFromEnvironment(), registry: createBookingRegistry({ boundary }) },
    ctx,
  );
  console.log(`[Session][${policy}] ${created ? "created" : "reopened"} ${sessionId}`);
  const trace = await attachTraceLogger(opened.harness, opened.root.id, (line) => console.log(line), ctx, { tag: policy });
  return { ...opened, boundary, trace };
}

async function ask(
  process: Awaited<ReturnType<typeof openProcess>>,
  policy: CaseNoteWritePolicy,
  prompt: string,
): Promise<void> {
  console.log(`\n[User][${policy}] ${prompt}`);
  const settled = await (await process.root.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
  await process.trace.settled(settled.id);
  assert(settled.status === "done", `a turn must finish: ${settled.status}`);
}

async function runScenario(policy: CaseNoteWritePolicy): Promise<ScenarioResult> {
  const sessionId = `context-projection-${policy}-${RUN_ID}`;
  console.log(`\n########## Scenario: ${policy} ##########`);

  const notes = CaseNoteRepository.fromDefaultFixture().findByBookingNo("BK1001");
  assert(notes.length === 2, "the fixture must hold two notes for BK1001");

  // Process 1: ground the model, then write both notes. Neither write calls a model.
  const first = await openProcess(policy, sessionId);
  console.log("\n=== Step 1: ground the model in one ordinary, always-projected fact ===");
  await ask(first, policy, GROUNDING_PROMPT);

  console.log("\n=== Step 2: write two durable case notes — one shared, one internal ===");
  console.log(
    "[Prediction] both notes are written with the same data and neither write touches a model. Whether either " +
      `reaches the model is decided only by whether the entry carries a model message (policy=${policy}), ` +
      "and an internal note never carries one. Neither note's internalOnly value is ever in a model message.",
  );
  for (const note of notes) {
    await appendCaseNote(first.root, note, policy, ctx);
  }
  const evidenceBeforeRestart = await caseNoteEvidence(first.root, ctx);
  printEvidence("before restart", evidenceBeforeRestart);
  await first.trace.stop();
  await first.harness.close(ctx);

  // Process 2: reopen the same storage. Everything below is read from durable data.
  console.log("\n=== Step 3: restart — reopen the storage, rebuild the forbidden list from durable data ===");
  const second = await openProcess(policy, sessionId);
  const armed = await forbidInternalOnlyValues(second.root, second.boundary, ctx);
  const evidence = await caseNoteEvidence(second.root, ctx);
  printEvidence("after restart", evidence);
  assert(
    JSON.stringify(evidence) === JSON.stringify(evidenceBeforeRestart),
    "what each note stores and contributes must be the same after a restart",
  );

  console.log("\n=== Step 4: ask a question only a leak could answer ===");
  await ask(second, policy, FOLLOW_UP_QUESTION);
  const answer = await lastAnswer(second.root);
  await second.trace.stop();
  await second.harness.close(ctx);

  const secrets = notes.flatMap((note) => (note.internalOnly === undefined ? [] : [note.internalOnly]));
  return {
    scenario: policy,
    notesDurable: evidence.length,
    storedModelMessages: sum(evidence, "storedModelMessages"),
    contributedMessages: sum(evidence, "contributedMessages"),
    armedForbiddenTexts: armed,
    requestsChecked: second.boundary.requests.length,
    violations: second.boundary.violations.length,
    answer,
    answerLeaksSecret: secrets.some((secret) => answer.includes(secret)),
    evidence,
  };
}

function assertBoundaryWasArmed(result: ScenarioResult): void {
  assert(
    result.armedForbiddenTexts === 2,
    `${result.scenario}: the guard must be armed with both internalOnly values, got ${result.armedForbiddenTexts}`,
  );
  assert(result.requestsChecked >= 1, `${result.scenario}: the guard must have checked at least one request`);
}

async function main(): Promise<void> {
  const durableOnly = await runScenario("durable-only");
  const projected = await runScenario("projected");

  console.log("\n########## Evidence summary ##########");
  console.table(
    [durableOnly, projected].map((result) => ({
      scenario: result.scenario,
      notesDurable: result.notesDurable,
      storedModelMessages: result.storedModelMessages,
      contributedMessages: result.contributedMessages,
      requestsChecked: result.requestsChecked,
      violations: result.violations,
      answerLeaksSecret: result.answerLeaksSecret,
    })),
  );

  assert(durableOnly.notesDurable === 2 && projected.notesDurable === 2, "both notes must be durable in both scenarios");
  assert(
    durableOnly.storedModelMessages === 0 && durableOnly.contributedMessages === 0,
    "durable-only: no note may store or contribute a model message",
  );
  assert(
    projected.storedModelMessages === 1 && projected.contributedMessages === 1,
    "projected: exactly one message — the shared note's — may be stored and contributed; the internal note still none",
  );
  const internal = projected.evidence.find((row) => row.visibility === "internal");
  assert(
    internal?.storedModelMessages === 0 && internal.contributedMessages === 0,
    "projected: the internal note must still contribute nothing",
  );

  for (const result of [durableOnly, projected]) {
    assertBoundaryWasArmed(result);
    assert(result.violations === 0, `${result.scenario}: no request may carry an internalOnly value`);
    assert(!result.answerLeaksSecret, `${result.scenario}: the final answer must not contain an internalOnly value: "${result.answer}"`);
  }

  console.log("\n=== All Lab 12 context-projection assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
