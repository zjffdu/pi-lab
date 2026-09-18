import "dotenv/config";

import { fileURLToPath } from "node:url";

import { estimateContextTokens, estimateTokens, type CompactionEntry, type Entry } from "@earendil-works/pi-agent-core";

import { openMainLane } from "../src/create-harness.js";
import { attachHarnessTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

/**
 * Deterministic script of prompts. Turn 2 is this lab's one "vulnerable early fact" — a
 * customs hold on BK1002, established once and never repeated — placed early enough that this
 * lab's tiny `keepRecentTokens` budget (see `compactionSettingsFromEnvironment`) pushes it past
 * the compaction cut point into the summarized region rather than the retained tail. Turns 5-8
 * are deliberately short, generic, one-sentence filler: they grow the conversation long enough
 * that the fixed summary/turn-prefix overhead compaction adds is a small fraction of what it
 * removes (see README section 5 for what happened when this lab tried a 5-turn conversation
 * instead), and they never repeat any early fact, so the retained tail after compaction has
 * real content of its own.
 */
const SEED_PROMPTS = [
  "Look up booking BK1001 and tell me its route, vessel, and planned dates.",
  "Now look up booking BK1002 as well. Flag anything unusual before we proceed.",
  "Check the container movement events for MSKU1234567 and summarize them briefly.",
  "Check the container movement events for MSKU7654321 and summarize them briefly.",
  "Given what you know so far, which of the two bookings looks more time-sensitive, and why?",
  "If the customer asks for an ETA update tomorrow, what would you check first, in one sentence?",
  "In one short sentence, what is the origin port for BK1001?",
  "In one short sentence, what vessel does BK1002 use?",
] as const;

const FOLLOW_UP_PROMPT =
  "Earlier we discussed two bookings. Which one had an unusual note flagged, and what was the note?";

const HOLD_KEYWORDS = ["phytosanitary", "customs hold", "customs"] as const;

const SESSION_GROUP = "lab-10-context-compaction-demo";
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assistantAnswerText(entry: Entry | undefined): string {
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
    return "";
  }
  return entry.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function mentionsHold(text: string): boolean {
  const lower = text.toLowerCase();
  return HOLD_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const TURNS_TO_KEEP = 3;

/**
 * A fixed `keepRecentTokens` constant is fragile against real, variable model output length:
 * the exact same seed prompt can produce an assistant reply a few tokens longer or shorter on
 * different runs, which can shift the cut point mid-turn (`isSplitTurn: true`) instead of
 * landing cleanly on a turn boundary — an earlier iteration of this script hit that: the cut
 * repeatedly split turn 5, and the extra turn-prefix summary that split produces was verbose
 * enough to outweigh what compaction actually saved (see README section 5). Computing
 * `keepRecentTokens` from the *actual* seeded transcript's own `estimateTokens` — the exact
 * same heuristic `findCutPoint` itself uses per message — instead guarantees the cut lands
 * exactly on turn `TURNS_TO_KEEP` messages back from the tip, every run, regardless of exact
 * wording.
 */
function keepRecentTokensForLastTurns(entries: Entry[], turnsToKeep: number): number {
  const messageEntries = [...entries]
    .sort((a, b) => a.seq - b.seq)
    .filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message");

  const turnStartIndices = messageEntries
    .map((entry, index) => (entry.message.role === "user" ? index : -1))
    .filter((index) => index >= 0);

  const keepFromIndex = turnStartIndices.at(-turnsToKeep);
  if (keepFromIndex === undefined) {
    throw new Error(`conversation does not have ${turnsToKeep} turns to compute keepRecentTokens from`);
  }

  return messageEntries.slice(keepFromIndex).reduce((sum, entry) => sum + estimateTokens(entry.message), 0);
}

interface ContextSample {
  label: string;
  messages: number;
  tokens: number;
}

interface ScenarioResult {
  label: string;
  sessionId: string;
  entriesBeforeCompaction: number;
  entriesAfterCompaction: number;
  compaction: CompactionEntry;
  lastSeedContextTokens: number;
  /** `estimateTokens(summary) + sum(estimateTokens(retainedTail))` — the reconstructed
   * post-compaction context measured the same message-by-message way `findCutPoint` itself
   * measures cost, deliberately NOT via `estimateContextTokens` on the live `transform_context`
   * payload (see README section 5: that path anchors on the last assistant message's *stale*,
   * pre-compaction `usage.totalTokens` once that message is recycled into `retainedTail`, which
   * overstates the real post-compaction request size). */
  reconstructedContextTokens: number;
  followUpContextTokens: number;
  followUpAnswer: string;
  answerMentionsHold: boolean;
}

async function runScenario(label: string, customInstructions: string | undefined): Promise<ScenarioResult> {
  console.log(`\n########## Scenario: ${label} ##########`);
  const sessionId = `compaction-${label}-${RUN_ID}`;
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);
  const { harness, lane } = await openMainLane(session, context);

  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));
  const contextSamples: ContextSample[] = [];
  const detachSampler = harness.hooks.on("transform_context", (event) => {
    const estimate = estimateContextTokens(event.messages);
    contextSamples.push({ label: `sample-${contextSamples.length}`, messages: event.messages.length, tokens: estimate.tokens });
    return undefined;
  });

  console.log(`\n=== Step 1: seed ${SEED_PROMPTS.length} deterministic turns ===`);
  for (const prompt of SEED_PROMPTS) {
    console.log(`[User][${sessionId}] ${prompt}`);
    const result = await lane.prompt(prompt, undefined, context);
    assert(result.ok, `${label}: seed turn must be admitted: ${!result.ok ? result.error.message : ""}`);
    if (result.ok && result.value.status !== "suspended") {
      assert(result.value.status === "completed", `${label}: seed turn must complete: ${JSON.stringify(result.value.error)}`);
    }
  }

  const lastSeedContextTokens = contextSamples.at(-1)?.tokens ?? 0;
  const entriesAfterSeed = await lane.findEntries(undefined, context);
  const entriesBeforeCompaction = entriesAfterSeed.length;
  console.log(
    `\n=== Step 2: measure context before compaction (entries=${entriesBeforeCompaction}, ` +
      `lastRequestTokens=${lastSeedContextTokens}) ===`,
  );

  const keepRecentTokens = keepRecentTokensForLastTurns(entriesAfterSeed, TURNS_TO_KEEP);
  const currentSettings = await harness.getCompactionSettings(context);
  await harness.setCompactionSettings({ ...currentSettings, keepRecentTokens }, context);
  console.log(
    `[Compaction][${sessionId}] computed keepRecentTokens=${keepRecentTokens} to retain exactly the last ${TURNS_TO_KEEP} turns ` +
      `(reserveTokens stays ${currentSettings.reserveTokens})`,
  );

  console.log(
    `\n=== Step 3: run lane.compact()${customInstructions ? ` with customInstructions="${customInstructions}"` : " (default settings)"} ===`,
  );
  const compactionResult = await lane.compact(customInstructions ? { customInstructions } : undefined, context);
  assert(compactionResult.ok, `${label}: compaction must be admitted: ${!compactionResult.ok ? compactionResult.error._tag : ""}`);
  if (!compactionResult.ok) {
    throw new Error("unreachable");
  }
  assert(
    compactionResult.value.compaction.status === "completed",
    `${label}: compaction must complete: ${JSON.stringify(compactionResult.value.compaction.error)}`,
  );

  const entriesAfterCompaction = (await lane.findEntries(undefined, context)).length;
  const allEntries = await lane.findEntries(undefined, context);
  const compactionEntry = allEntries.find((entry): entry is CompactionEntry => entry.type === "compaction");
  assert(Boolean(compactionEntry), `${label}: a durable compaction entry must exist after lane.compact()`);

  const compactionRecord = compactionEntry as CompactionEntry;
  const summaryTokens = Math.ceil(compactionRecord.summary.length / 4);
  const retainedTailTokens = compactionRecord.retainedTail.reduce((sum, message) => sum + estimateTokens(message), 0);
  const reconstructedContextTokens = summaryTokens + retainedTailTokens;

  console.log(
    `[Compaction][${sessionId}] tokensBefore=${compactionRecord.tokensBefore} retainedTail=${compactionRecord.retainedTail.length} ` +
      `summaryTokens=${summaryTokens} retainedTailTokens=${retainedTailTokens} reconstructedContextTokens=${reconstructedContextTokens} ` +
      `summary="${compactionRecord.summary.slice(0, 160)}..."`,
  );

  assert(
    entriesAfterCompaction === entriesBeforeCompaction + 1,
    `${label}: compaction must add exactly one new entry and must not delete the ${entriesBeforeCompaction} pre-compaction entries ` +
      `(before=${entriesBeforeCompaction}, after=${entriesAfterCompaction})`,
  );

  console.log(`\n=== Step 4: ask the follow-up question ===`);
  console.log(`[User][${sessionId}] ${FOLLOW_UP_PROMPT}`);
  const followUpResult = await lane.prompt(FOLLOW_UP_PROMPT, undefined, context);
  assert(followUpResult.ok, `${label}: follow-up turn must be admitted`);
  assert(
    followUpResult.ok && followUpResult.value.status === "completed",
    `${label}: follow-up turn must complete`,
  );

  const followUpContextTokens = contextSamples.at(-1)?.tokens ?? 0;
  const finalEntries = await lane.findEntries(undefined, context);
  const followUpTipId = followUpResult.ok && followUpResult.value.status !== "suspended" ? followUpResult.value.tipId : null;
  const followUpEntry = finalEntries.find((entry) => entry.id === followUpTipId);
  const followUpAnswer = assistantAnswerText(followUpEntry);
  console.log(`[Assistant][${sessionId}] ${followUpAnswer}`);

  detachSampler();
  detachTrace();
  await harness.close(context);
  await repo.close(context);

  return {
    label,
    sessionId,
    entriesBeforeCompaction,
    entriesAfterCompaction,
    compaction: compactionRecord,
    lastSeedContextTokens,
    reconstructedContextTokens,
    followUpContextTokens,
    followUpAnswer,
    answerMentionsHold: mentionsHold(followUpAnswer),
  };
}

async function main(): Promise<void> {
  const defaultScenario = await runScenario("default", undefined);
  const instructedScenario = await runScenario(
    "instructed",
    "Explicitly preserve every booking identifier, container number, and any noted hold, " +
      "exception, or evidence gap, even if it seems minor.",
  );

  console.log("\n########## Evidence summary ##########");
  console.table(
    [defaultScenario, instructedScenario].map((scenario) => ({
      scenario: scenario.label,
      entriesBefore: scenario.entriesBeforeCompaction,
      entriesAfter: scenario.entriesAfterCompaction,
      tokensBeforeCompaction: scenario.compaction.tokensBefore,
      retainedTailMessages: scenario.compaction.retainedTail.length,
      reconstructedContextTokens: scenario.reconstructedContextTokens,
      lastSeedRequestTokens: scenario.lastSeedContextTokens,
      followUpRequestTokens_STALE_USAGE_ARTIFACT: scenario.followUpContextTokens,
      followUpMentionsHold: scenario.answerMentionsHold,
    })),
  );

  console.log(`\n[default] summary: ${defaultScenario.compaction.summary}`);
  console.log(`\n[instructed] summary: ${instructedScenario.compaction.summary}`);
  console.log(`\n[default] follow-up answer: ${defaultScenario.followUpAnswer}`);
  console.log(`\n[instructed] follow-up answer: ${instructedScenario.followUpAnswer}`);

  assert(
    defaultScenario.reconstructedContextTokens < defaultScenario.compaction.tokensBefore,
    `default: the reconstructed post-compaction context (${defaultScenario.reconstructedContextTokens} tokens: summary + ` +
      `retained tail) must be smaller than tokensBefore (${defaultScenario.compaction.tokensBefore})`,
  );
  assert(
    instructedScenario.reconstructedContextTokens < instructedScenario.compaction.tokensBefore,
    `instructed: the reconstructed post-compaction context (${instructedScenario.reconstructedContextTokens} tokens: summary + ` +
      `retained tail) must be smaller than tokensBefore (${instructedScenario.compaction.tokensBefore})`,
  );
  assert(
    instructedScenario.answerMentionsHold,
    "instructed: compaction with explicit preservation instructions must keep the customs-hold fact recoverable",
  );

  console.log("\n=== All Lab 10 context-compaction assertions passed ===");
  console.log(
    `\n[Note] default follow-up answer ${defaultScenario.answerMentionsHold ? "DID" : "did NOT"} recover the customs-hold fact; ` +
      `instructed follow-up answer ${instructedScenario.answerMentionsHold ? "DID" : "did NOT"}. Either direction for the default ` +
      "run is a legitimate finding worth recording verbatim in the README — this script does not assume which way it goes.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
