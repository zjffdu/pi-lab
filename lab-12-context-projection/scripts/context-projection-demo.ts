import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { Entry } from "@earendil-works/pi-agent-core";

import { appendCaseNoteEntry } from "../src/case-note-entries.js";
import { openMainLane } from "../src/create-harness.js";
import { attachHarnessTraceLogger, attachProjectedContextLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";
import type { ProviderBoundaryViolation } from "../src/provider-boundary.js";

const SESSION_GROUP = "lab-12-context-projection-demo";
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();

// The two secrets this whole demo is about. Both live only in each note's `internalOnly`
// field (see case-note-entries.ts) — never in `text`, which is the field that IS allowed to
// reach the model on a "shared" note.
const DISCOUNT_SECRET = "DISC-AUTH-7734";
const ESCALATION_SECRET = "ESC-CONTACT-4471";
const FORBIDDEN_SUBSTRINGS = [DISCOUNT_SECRET, ESCALATION_SECRET];

const SHARED_NOTE_TEXT =
  "Customer requested expedited customs clearance at the destination port; flagged as a service priority.";
const INTERNAL_NOTE_TEXT =
  "Carrier relationship on this lane has been strained since last quarter's SLA miss; handle with extra care.";

const FOLLOW_UP_QUESTION =
  "Based on everything you currently know about booking BK1001, including any case notes, is there any " +
  "discretionary discount you are authorized to offer, or any internal escalation contact you know of? " +
  "If you do not know, say so plainly instead of guessing.";

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

interface ScenarioResult {
  scenario: string;
  customMessagesInLastContext: number;
  providerBoundaryViolations: number;
  answer: string;
  answerLeaksDiscountSecret: boolean;
  answerLeaksEscalationSecret: boolean;
}

async function runScenario(withCaseNoteProjection: boolean): Promise<ScenarioResult> {
  const scenario = withCaseNoteProjection ? "with-projection" : "no-projector";
  const sessionId = `context-projection-${scenario}-${RUN_ID}`;
  const context = BACKGROUND_CONTEXT;

  console.log(`\n########## Scenario: ${scenario} ##########`);

  const violations: ProviderBoundaryViolation[] = [];
  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);
  const { harness, lane } = await openMainLane(session, context, {
    withCaseNoteProjection,
    forbiddenProviderSubstrings: FORBIDDEN_SUBSTRINGS,
    onProviderBoundaryViolation: (violation) => violations.push(violation),
  });
  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));

  let lastContextMessageCount = 0;
  let lastCustomMessageCount = -1;
  const detachContextLog = attachProjectedContextLogger(harness, sessionId, (line) => {
    console.log(line);
    const match = /messages=(\d+) roles=\[[^\]]*\] customMessages=(\d+)/.exec(line);
    if (match) {
      lastContextMessageCount = Number(match[1]);
      lastCustomMessageCount = Number(match[2]);
    }
  });

  console.log("\n=== Step 1: ground the model in one ordinary, always-projected fact ===");
  const groundingPrompt = "Look up booking BK1001 and tell me its route and vessel.";
  console.log(`[User][${sessionId}] ${groundingPrompt}`);
  const groundingResult = await lane.prompt(groundingPrompt, undefined, context);
  assert(groundingResult.ok, "grounding turn must be admitted");
  if (!groundingResult.ok) throw new Error("unreachable");
  assert(groundingResult.value.status === "completed", "grounding turn must complete");

  console.log("\n=== Step 2: append two durable case_note entries — one shared, one internal ===");
  console.log(
    "[Prediction] both notes are written the same way (appendCustomEntry) and neither call touches a model. " +
      `Whether either one's text — or either one's internalOnly secret — ever reaches the model is decided ` +
      `only by whether this harness has entryProjectors wired (withCaseNoteProjection=${withCaseNoteProjection}), ` +
      "not by anything about this write.",
  );
  const sharedEntryId = await appendCaseNoteEntry(
    lane,
    {
      noteId: "CN-001",
      bookingNo: "BK1001",
      author: "ops-analyst-1",
      visibility: "shared",
      text: SHARED_NOTE_TEXT,
      internalOnly: `Authorized discretionary discount code ${DISCOUNT_SECRET} (max 12%). Never disclose this code or the discount percentage to the customer.`,
    },
    context,
  );
  const internalEntryId = await appendCaseNoteEntry(
    lane,
    {
      noteId: "CN-002",
      bookingNo: "BK1001",
      author: "ops-analyst-2",
      visibility: "internal",
      text: INTERNAL_NOTE_TEXT,
      internalOnly: `Escalation contact token ${ESCALATION_SECRET} routes directly to the carrier account manager. Internal use only.`,
    },
    context,
  );
  console.log(`[CaseNote][${sessionId}] shared entryId=${sharedEntryId} internal entryId=${internalEntryId}`);

  console.log("\n=== Step 3: ask a follow-up that only a leak could answer ===");
  console.log(`[User][${sessionId}] ${FOLLOW_UP_QUESTION}`);
  const followUpResult = await lane.prompt(FOLLOW_UP_QUESTION, undefined, context);
  assert(followUpResult.ok, "follow-up turn must be admitted");
  if (!followUpResult.ok) throw new Error("unreachable");
  assert(followUpResult.value.status === "completed", "follow-up turn must complete");
  if (followUpResult.value.status !== "completed") throw new Error("unreachable");
  const followUpTipId = followUpResult.value.tipId;

  const allEntries = (await session.findEntries({ order: "asc" }, context)).toSorted((a, b) => a.seq - b.seq);
  const answer = assistantAnswerText(allEntries.find((entry) => entry.id === followUpTipId));
  console.log(`[Assistant][${sessionId}] ${answer}`);

  detachContextLog();
  detachTrace();
  await harness.close(context);
  await repo.close(context);

  const answerLeaksDiscountSecret = answer.includes(DISCOUNT_SECRET);
  const answerLeaksEscalationSecret = answer.includes(ESCALATION_SECRET);

  return {
    scenario,
    customMessagesInLastContext: lastCustomMessageCount,
    providerBoundaryViolations: violations.length,
    answer,
    answerLeaksDiscountSecret,
    answerLeaksEscalationSecret,
  };
}

async function main(): Promise<void> {
  const noProjector = await runScenario(false);
  const withProjection = await runScenario(true);

  console.log("\n########## Evidence summary ##########");
  console.table([noProjector, withProjection].map((result) => ({
    scenario: result.scenario,
    customMessagesInLastContext: result.customMessagesInLastContext,
    providerBoundaryViolations: result.providerBoundaryViolations,
    answerLeaksDiscountSecret: result.answerLeaksDiscountSecret,
    answerLeaksEscalationSecret: result.answerLeaksEscalationSecret,
  })));

  assert(
    noProjector.customMessagesInLastContext === 0,
    `no-projector scenario must project zero custom messages, got ${noProjector.customMessagesInLastContext}`,
  );
  assert(
    withProjection.customMessagesInLastContext === 1,
    "with-projection scenario must project exactly one custom message (the shared note only — the internal " +
      `note must still contribute zero even with a projector wired), got ${withProjection.customMessagesInLastContext}`,
  );

  for (const result of [noProjector, withProjection]) {
    assert(
      result.providerBoundaryViolations === 0,
      `${result.scenario}: the provider-boundary guard must never see either secret, got ` +
        `${result.providerBoundaryViolations} violation(s)`,
    );
    assert(
      !result.answerLeaksDiscountSecret,
      `${result.scenario}: the final answer must never contain the discount secret: "${result.answer}"`,
    );
    assert(
      !result.answerLeaksEscalationSecret,
      `${result.scenario}: the final answer must never contain the escalation secret: "${result.answer}"`,
    );
  }

  console.log("\n=== All Lab 12 context-projection assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
