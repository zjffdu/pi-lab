import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { BranchSummaryEntry, Entry } from "@earendil-works/pi-agent-core";

import { openMainLane } from "../src/create-harness.js";
import { attachHarnessTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";
import { findBranchTips, renderTree } from "../src/tree-view.js";

const SESSION_GROUP = "lab-11-session-tree-demo";
const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();

const BRANCH_POINT_LABEL = "after-bk1001-lookup";
const VESSEL_QUESTION =
  "Which vessel is the booking we are currently discussing on? Answer in one short sentence naming only the vessel.";

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

async function main(): Promise<void> {
  const sessionId = `session-tree-${RUN_ID}`;
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);
  const { harness, lane } = await openMainLane(session, context);
  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));

  async function allEntriesChronological(): Promise<Entry[]> {
    return (await session.findEntries({ order: "asc" }, context)).toSorted((a, b) => a.seq - b.seq);
  }

  async function askAndComplete(prompt: string): Promise<{ tipId: string; answer: string }> {
    console.log(`[User][${sessionId}] ${prompt}`);
    const result = await lane.prompt(prompt, undefined, context);
    assert(result.ok, `turn must be admitted: ${!result.ok ? result.error.message : ""}`);
    if (!result.ok) throw new Error("unreachable");
    assert(result.value.status === "completed", `turn must complete: ${JSON.stringify(result.value)}`);
    if (result.value.status !== "completed") throw new Error("unreachable");
    const tipId = result.value.tipId;
    assert(tipId !== null, "a completed run must produce a non-null tip");
    const entries = await allEntriesChronological();
    const answer = assistantAnswerText(entries.find((entry) => entry.id === tipId));
    console.log(`[Assistant][${sessionId}] ${answer}`);
    return { tipId: tipId as string, answer };
  }

  console.log("\n=== Step 1: seed the shared ancestry both branches will fork from ===");
  const afterLookup = await askAndComplete("Look up booking BK1001 and tell me its route and vessel.");
  const branchPointId = afterLookup.tipId;

  console.log("\n=== Step 2: continue forward into a completed investigation on branch A ===");
  const afterEvents = await askAndComplete(
    "Check the container movement events for MSKU1234567 and summarize them in one sentence.",
  );
  const afterRiskCall = await askAndComplete(
    "Given what you know so far, is this booking on schedule or at risk? Answer in one sentence.",
  );
  const branchATipId = afterRiskCall.tipId;

  const entriesAfterBranchA = await allEntriesChronological();
  console.log(`\n[Tree] after branch A: entries=${entriesAfterBranchA.length} tips=${findBranchTips(entriesAfterBranchA).join(", ")}`);
  assert(
    findBranchTips(entriesAfterBranchA).length === 1,
    "before any navigation, the whole tree must still be one linear branch with exactly one tip",
  );

  console.log("\n=== Step 3: predict, then navigate back to the branch point ===");
  console.log(
    "[Prediction] navigateTree(branchPointId) should move only the lane's tip pointer back to " +
      `${branchPointId}; it must not delete entries ${afterEvents.tipId} or ${branchATipId}, and the next prompt ` +
      "should parent off the branch point, not off the current branch-A tip.",
  );
  const navToBranchPoint = await lane.navigateTree(branchPointId, { label: BRANCH_POINT_LABEL }, context);
  assert(navToBranchPoint.ok, `navigation must be admitted: ${!navToBranchPoint.ok ? navToBranchPoint.error._tag : ""}`);
  if (!navToBranchPoint.ok) throw new Error("unreachable");
  assert(
    navToBranchPoint.value.navigation.status === "completed",
    `navigation must complete: ${JSON.stringify(navToBranchPoint.value.navigation.error)}`,
  );
  assert(
    navToBranchPoint.value.navigation.tipId === branchPointId,
    "navigation must set the lane's tip to the requested target",
  );
  assert(
    navToBranchPoint.value.navigation.fromTipId === branchATipId,
    "navigation's fromTipId must be the tip observed just before navigating",
  );

  const tipAfterNav = await lane.getTipId(context);
  assert(tipAfterNav === branchPointId, "lane.getTipId() must reflect the new tip immediately after navigateTree()");

  const label = await harness.getLabel(branchPointId, context);
  assert(label === BRANCH_POINT_LABEL, `navigateTree({label}) must persist the label on the target entry, got ${label}`);

  const entriesAfterNav = await allEntriesChronological();
  assert(
    entriesAfterNav.length === entriesAfterBranchA.length,
    `unsummarized navigation must not create or delete any entry (before=${entriesAfterBranchA.length}, ` +
      `after=${entriesAfterNav.length})`,
  );

  console.log("\n=== Step 4: continue with a changed premise — this forks branch B off the same branch point ===");
  const afterCorrection = await askAndComplete(
    "Actually, I made an error — the booking we should be discussing is BK1002, not BK1001. Look it up and tell " +
      "me its route and vessel.",
  );
  const branchBTipId = afterCorrection.tipId;

  const entriesAfterBranchB = await allEntriesChronological();
  const tipsAfterBranchB = findBranchTips(entriesAfterBranchB);
  console.log(`\n[Tree] after branch B forks: entries=${entriesAfterBranchB.length} tips=${tipsAfterBranchB.join(", ")}`);
  console.log(renderTree(entriesAfterBranchB, { labels: new Map([[branchPointId, BRANCH_POINT_LABEL]]), activeTipId: branchBTipId }));

  assert(
    tipsAfterBranchB.length === 2 && tipsAfterBranchB.includes(branchATipId) && tipsAfterBranchB.includes(branchBTipId),
    `the tree must now have exactly two tips, branch A's (${branchATipId}) and branch B's (${branchBTipId}); ` +
      `got [${tipsAfterBranchB.join(", ")}]`,
  );
  const branchPointChildren = entriesAfterBranchB.filter((entry) => entry.parentId === branchPointId);
  assert(
    branchPointChildren.length === 2,
    `the branch point must have exactly two children after the fork, got ${branchPointChildren.length}`,
  );

  console.log("\n=== Step 5: contrast — ask the identical follow-up from each branch's own tip ===");
  console.log(`[Prediction] switching to branch A's tip and asking "${VESSEL_QUESTION}" should answer MAERSK TEST ` +
    "(BK1001); switching to branch B's tip and asking the exact same question should answer MAERSK SECOND " +
    "(BK1002) — each branch must only see its own ancestry, not the other branch's tool result.");

  const navToA = await lane.navigateTree(branchATipId, undefined, context);
  assert(navToA.ok && navToA.value.navigation.status === "completed", "navigating to branch A's tip must succeed");
  const answerFromA = await askAndComplete(VESSEL_QUESTION);

  const navToB = await lane.navigateTree(branchBTipId, undefined, context);
  assert(navToB.ok && navToB.value.navigation.status === "completed", "navigating to branch B's tip must succeed");
  const answerFromB = await askAndComplete(VESSEL_QUESTION);

  const answerAMentionsTest = answerFromA.answer.toUpperCase().includes("MAERSK TEST");
  const answerAMentionsSecond = answerFromA.answer.toUpperCase().includes("MAERSK SECOND");
  const answerBMentionsSecond = answerFromB.answer.toUpperCase().includes("MAERSK SECOND");
  const answerBMentionsTest = answerFromB.answer.toUpperCase().includes("MAERSK TEST");

  console.table([
    { branch: "A (BK1001)", answer: answerFromA.answer, mentionsOwnVessel: answerAMentionsTest, mentionsOtherVessel: answerAMentionsSecond },
    { branch: "B (BK1002)", answer: answerFromB.answer, mentionsOwnVessel: answerBMentionsSecond, mentionsOtherVessel: answerBMentionsTest },
  ]);

  assert(answerAMentionsTest, `branch A's follow-up must name its own booking's vessel (MAERSK TEST): "${answerFromA.answer}"`);
  assert(!answerAMentionsSecond, `branch A's follow-up must not leak branch B's vessel (MAERSK SECOND): "${answerFromA.answer}"`);
  assert(answerBMentionsSecond, `branch B's follow-up must name its own booking's vessel (MAERSK SECOND): "${answerFromB.answer}"`);
  assert(!answerBMentionsTest, `branch B's follow-up must not leak branch A's vessel (MAERSK TEST): "${answerFromB.answer}"`);

  console.log("\n=== Step 6: switching branches again proves neither continuation was overwritten ===");
  const finalEntries = await allEntriesChronological();
  const finalTips = findBranchTips(finalEntries);
  console.log(`[Tree] final: entries=${finalEntries.length} tips=${finalTips.join(", ")}`);
  console.log(renderTree(finalEntries, { labels: new Map([[branchPointId, BRANCH_POINT_LABEL]]), activeTipId: await lane.getTipId(context) }));

  assert(
    finalEntries.length > entriesAfterBranchB.length,
    "asking the contrast follow-up from both tips must grow the tree, not replace anything in it",
  );
  assert(
    finalEntries.some((entry) => entry.id === branchATipId) && finalEntries.some((entry) => entry.id === branchBTipId),
    "both branch A's original tip and branch B's original tip must still exist as durable entries",
  );
  assert(
    !finalTips.includes(branchATipId) && !finalTips.includes(branchBTipId),
    "branch A's and branch B's ORIGINAL tips are no longer leaves once each grew a contrast-question child — " +
      "that is expected; the entries themselves are still present, just not tips any more",
  );

  console.log("\n=== Step 7 (bonus): one summarized-navigation experiment, now that the unsummarized case is proven ===");
  console.log(
    "[Prediction] navigateTree(branchPointId, {summarize:true}) from branch B's current tip should generate one " +
      "new branch_summary entry — parented at the branch point, with fromId pointing at branch B's abandoned tip " +
      "— and make THAT new entry the tip, instead of moving the pointer directly to branchPointId.",
  );
  const beforeSummarizedNav = await lane.getTipId(context);
  const summarizedNav = await lane.navigateTree(branchPointId, { summarize: true }, context);
  assert(summarizedNav.ok, `summarized navigation must be admitted: ${!summarizedNav.ok ? summarizedNav.error._tag : ""}`);
  if (!summarizedNav.ok) throw new Error("unreachable");
  assert(
    summarizedNav.value.navigation.status === "completed",
    `summarized navigation must complete: ${JSON.stringify(summarizedNav.value.navigation.error)}`,
  );
  const summaryTipId = summarizedNav.value.navigation.tipId;
  assert(
    summaryTipId !== null && summaryTipId !== branchPointId,
    "summarized navigation's new tip must be a freshly generated branch_summary entry, not the target itself",
  );

  const entriesAfterSummary = await allEntriesChronological();
  const summaryEntry = entriesAfterSummary.find(
    (entry): entry is BranchSummaryEntry => entry.type === "branch_summary" && entry.id === summaryTipId,
  );
  assert(Boolean(summaryEntry), "a durable branch_summary entry must exist at the new tip");
  if (summaryEntry) {
    assert(summaryEntry.parentId === branchPointId, "the branch_summary entry must be parented at the navigation target");
    assert(
      summaryEntry.fromId === beforeSummarizedNav,
      `the branch_summary entry's fromId must be the tip that was abandoned (${beforeSummarizedNav}), got ${summaryEntry.fromId}`,
    );
    console.log(`[BranchSummary][${sessionId}] fromId=${summaryEntry.fromId} parentId=${summaryEntry.parentId}`);
    console.log(`[BranchSummary][${sessionId}] summary="${summaryEntry.summary.slice(0, 200)}..."`);
  }
  assert(
    entriesAfterSummary.length === finalEntries.length + 1,
    "summarized navigation must add exactly one new durable entry and must not delete anything the unsummarized " +
      `experiment already produced (before=${finalEntries.length}, after=${entriesAfterSummary.length})`,
  );

  const finalTipsWithSummary = findBranchTips(entriesAfterSummary);
  console.log(`[Tree] after summarized navigation: entries=${entriesAfterSummary.length} tips=${finalTipsWithSummary.join(", ")}`);
  assert(
    entriesAfterSummary.some((entry) => entry.id === branchATipId) &&
      entriesAfterSummary.some((entry) => entry.id === branchBTipId),
    "branch A's and branch B's original tip entries must both still be present (as non-tip ancestors) after a " +
      "summarized navigation elsewhere in the tree — summarization compresses what a future request sees, it " +
      "does not delete durable history",
  );

  detachTrace();
  await harness.close(context);
  await repo.close(context);

  console.log("\n=== All Lab 11 session-tree assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
