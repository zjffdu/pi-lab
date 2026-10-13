import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { Usage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { estimateContextTokens as usageAnchoredEstimate } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionPolicy, EntryRecord } from "@earendil-works/pi-durable";

import { BookingRepository } from "../src/booking-repository.js";
import {
  compactConversation,
  compactionEntries,
  compactionSummaryText,
  estimatedContextTokens,
  extractShipmentIdentifiers,
  keepRecentTokensForLastTurns,
} from "../src/compaction.js";
import { compactionPolicyFromEnvironment, modelSelectionFromEnvironment, openRootConversation } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";

/**
 * Turn 2 is this lab's one "vulnerable early fact": BK1002's customs hold enters the transcript
 * exactly once, as the content of that turn's `get_booking` tool result, and is never repeated.
 * Turns 5-8 are short filler that never mention it again.
 */
const SEED_PROMPTS = [
  "Look up booking BK1001 and tell me its route, vessel, and planned dates.",
  "Now look up booking BK1002 as well. Flag anything unusual before we proceed.",
  "Check the container movement events for every container of BK1001 and summarize them briefly.",
  "Check the container movement events for MSKU7654321 and summarize them briefly.",
  "Given what you know so far, which of the two bookings looks more time-sensitive, and why?",
  "If the customer asks for an ETA update tomorrow, what would you check first, in one sentence?",
  "In one short sentence, what is the origin port for BK1001?",
  "In one short sentence, what vessel does BK1002 use?",
] as const;

const FOLLOW_UP_PROMPT =
  "Earlier we discussed two bookings. Which one had an unusual note flagged, and what was the note?";

const TURNS_TO_KEEP = 3;
const HOLD_KEYWORDS = ["phytosanitary", "customs hold"] as const;
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();
const context = BACKGROUND_CONTEXT;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assistantUsage(entry: EntryRecord | undefined): Usage | undefined {
  const message = entry?.model?.[0];
  return message?.role === "assistant" ? message.usage : undefined;
}

/** What the provider actually read for that request, from its own report — not an estimate. */
function promptTokens(usage: Usage | undefined): number {
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
}

function answerText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") {
    return "";
  }
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
}

interface ScenarioResult {
  label: string;
  entriesBefore: number;
  entriesAfter: number;
  summaryTokens: number;
  headKind: string;
  estimatedBefore: number;
  estimatedAfter: number;
  usageAnchoredBefore: string;
  usageAnchoredAfter: string;
  providerPromptBefore: number;
  providerPromptAfter: number;
  summary: string;
  unknownIdentifiers: string[];
  followUpAnswer: string;
  answerMentionsHold: boolean;
}

async function runScenario(label: string, customInstructions: string | undefined): Promise<ScenarioResult> {
  console.log(`\n########## Scenario: ${label} ##########`);
  const sessionId = `compaction-${label}-${RUN_ID}`;
  const models = builtinModels();
  const compaction: Partial<CompactionPolicy> = compactionPolicyFromEnvironment();

  const { storage } = await openSessionStorage(SESSIONS_ROOT, sessionId, context);
  const { harness, root } = await openRootConversation(
    storage,
    { models, selection: modelSelectionFromEnvironment(), compaction },
    context,
  );
  const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);

  async function ask(prompt: string) {
    console.log(`[User][${sessionId}] ${prompt}`);
    const submission = await root.submit({ type: "input", content: prompt }, context);
    const settled = await submission.wait(context);
    await trace.settled(settled.id);
    assert(settled.status === "done", `${label}: turn must settle done, got ${JSON.stringify(settled)}`);
    return settled;
  }

  console.log(`\n=== Step 1: seed ${SEED_PROMPTS.length} deterministic turns ===`);
  for (const prompt of SEED_PROMPTS) {
    await ask(prompt);
  }

  const entriesBefore = await listEntries(root, context);
  const viewBefore = await root.context(context);
  const lastBefore = assistantUsage(entriesBefore.findLast((entry) => entry.kind === "pi.assistant"));
  const providerPromptBefore = promptTokens(lastBefore);
  const estimatedBefore = estimatedContextTokens(viewBefore);
  const anchoredBefore = usageAnchoredEstimate(viewBefore.messages);
  console.log(
    `\n=== Step 2: measure before compaction: entries=${entriesBefore.length} contextMessages=${viewBefore.messages.length} ` +
      `estimatedTokens=${estimatedBefore} providerReportedPromptTokens(last request)=${providerPromptBefore} ===`,
  );

  compaction.keepRecentTokens = keepRecentTokensForLastTurns(viewBefore, TURNS_TO_KEEP);
  console.log(
    `[Compaction][${sessionId}] keepRecentTokens=${compaction.keepRecentTokens} computed to keep the last ${TURNS_TO_KEEP} turns`,
  );

  console.log(
    `\n=== Step 3: Conversation.compact()${customInstructions ? ` with instructions="${customInstructions}"` : " (no instructions)"} ===`,
  );
  const outcome = await compactConversation(harness, root, customInstructions, context);
  assert(outcome.kind === "placed", `${label}: compaction must be placed, got ${JSON.stringify(outcome)}`);

  const entriesAfter = await listEntries(root, context);
  assert(entriesAfter.length === entriesBefore.length + 1, `${label}: exactly one entry must be added (${entriesBefore.length} -> ${entriesAfter.length})`);
  assert(
    JSON.stringify(entriesAfter.slice(0, entriesBefore.length)) === JSON.stringify(entriesBefore),
    `${label}: every pre-compaction entry must be unchanged`,
  );

  const [compactionEntry] = compactionEntries(entriesAfter);
  assert(compactionEntry !== undefined && compactionEntry.head !== undefined, `${label}: a pi.compaction entry with a head must exist`);
  const headEntry = entriesBefore.find((entry) => entry.id === compactionEntry!.head);
  const headKind = headEntry?.kind ?? "unknown";
  const turn6User = entriesBefore.filter((entry) => entry.kind === "pi.user")[SEED_PROMPTS.length - TURNS_TO_KEEP];
  assert(headEntry?.id === turn6User?.id, `${label}: the cut must land on the user message that starts turn ${SEED_PROMPTS.length - TURNS_TO_KEEP + 1}`);

  const summary = compactionSummaryText(compactionEntry!);
  const knownIdentifiers = new Set(
    BookingRepository.fromDefaultFixture().all().flatMap((booking) => [booking.bookingNo, ...booking.containerNos]),
  );
  const unknownIdentifiers = extractShipmentIdentifiers(summary).filter((identifier) => !knownIdentifiers.has(identifier));
  console.log(
    `[Provenance][${sessionId}] identifiers in summary: ${extractShipmentIdentifiers(summary).join(", ")}; ` +
      `not in the fixtures: [${unknownIdentifiers.join(", ")}]`,
  );
  assert(unknownIdentifiers.length === 0, `${label}: the summary must not contain an identifier absent from the fixtures: ${unknownIdentifiers.join(", ")}`);
  const viewAfter = await root.context(context);
  const estimatedAfter = estimatedContextTokens(viewAfter);
  const anchoredAfter = usageAnchoredEstimate(viewAfter.messages);
  const usageAnchoredBefore = `${anchoredBefore.tokens} (anchor@${anchoredBefore.lastUsageIndex ?? "none"})`;
  const usageAnchoredAfter = `${anchoredAfter.tokens} (anchor@${anchoredAfter.lastUsageIndex ?? "none"})`;
  console.log(
    `[Compaction][${sessionId}] entry=${compactionEntry!.id} head=${compactionEntry!.head} (${headKind}) ` +
      `contextMessages=${viewAfter.messages.length} estimatedTokens(after)=${estimatedAfter} ` +
      `usageAnchoredEstimate(before)=${usageAnchoredBefore} (after)=${usageAnchoredAfter}`,
  );
  assert(estimatedAfter < estimatedBefore, `${label}: the next request's context must be smaller (${estimatedBefore} -> ${estimatedAfter})`);

  console.log(`\n=== Step 4: ask the follow-up question ===`);
  const settled = await ask(FOLLOW_UP_PROMPT);
  const finalEntries = await listEntries(root, context);
  const followUpEntry = finalEntries.find((entry) => "answer" in settled && entry.id === settled.answer);
  const followUpAnswer = answerText(followUpEntry);
  const providerPromptAfter = promptTokens(assistantUsage(followUpEntry));
  console.log(`[Assistant][${sessionId}] ${followUpAnswer}`);
  console.log(`[Compaction][${sessionId}] providerReportedPromptTokens(follow-up request)=${providerPromptAfter}`);
  assert(
    providerPromptAfter > 0 && providerPromptAfter < providerPromptBefore,
    `${label}: the provider must have read fewer prompt tokens after compaction (${providerPromptBefore} -> ${providerPromptAfter})`,
  );

  await trace.stop();
  await harness.close(context);

  return {
    label,
    entriesBefore: entriesBefore.length,
    entriesAfter: entriesAfter.length,
    summaryTokens: Math.ceil(summary.length / 3.5),
    headKind,
    estimatedBefore,
    estimatedAfter,
    usageAnchoredBefore,
    usageAnchoredAfter,
    providerPromptBefore,
    providerPromptAfter,
    summary,
    unknownIdentifiers,
    followUpAnswer,
    answerMentionsHold: HOLD_KEYWORDS.some((keyword) => followUpAnswer.toLowerCase().includes(keyword)),
  };
}

async function main(): Promise<void> {
  const defaultScenario = await runScenario("default", undefined);
  const instructedScenario = await runScenario(
    "instructed",
    "Explicitly preserve every booking identifier, container number, and any noted hold, exception, or evidence gap, even if it seems minor.",
  );
  const results = [defaultScenario, instructedScenario];

  console.log("\n########## Evidence summary ##########");
  console.table(
    results.map((result) => ({
      scenario: result.label,
      entries: `${result.entriesBefore} -> ${result.entriesAfter}`,
      headKind: result.headKind,
      estimatedBefore: result.estimatedBefore,
      estimatedAfter: result.estimatedAfter,
      providerPromptBefore: result.providerPromptBefore,
      providerPromptAfter: result.providerPromptAfter,
      usageAnchoredBefore: result.usageAnchoredBefore,
      usageAnchoredAfter: result.usageAnchoredAfter,
      followUpMentionsHold: result.answerMentionsHold,
    })),
  );

  for (const result of results) {
    console.log(`\n[${result.label}] summary:\n${result.summary}`);
    console.log(`\n[${result.label}] follow-up answer: ${result.followUpAnswer}`);
  }

  assert(instructedScenario.answerMentionsHold, "instructed: the follow-up answer must recover the customs-hold fact");

  console.log("\n=== All Lab 10 context-compaction assertions passed ===");
  console.log(
    `\n[Note] default follow-up answer ${defaultScenario.answerMentionsHold ? "DID" : "did NOT"} recover the customs-hold fact; ` +
      `instructed ${instructedScenario.answerMentionsHold ? "DID" : "did NOT"}. This script does not assume which way the default goes.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
