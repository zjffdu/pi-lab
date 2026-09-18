import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";
import { findBranchTips } from "../src/tree-view.js";

/**
 * Deterministic, network-free proof of `navigateTree()` itself. The UNSUMMARIZED path
 * (`summarize` defaults to `false` — see `acceptNavigation` in
 * `dist/harness/runtime/lane.js`) never calls a model: it only moves the durable
 * `branchTip(lane.name)` pointer and, optionally, writes an `entryLabel` value (see
 * `commitNavigation` in `dist/harness/runtime/drive/structural.js`). That means the entire
 * "one tree, two tips, nothing overwritten" claim can be proven here with
 * `lane.appendMessage()` seeding (same premise Lab 07-10's durability tests and
 * `tests/compaction-mechanics.test.ts` use) and zero live model calls. Only the SUMMARIZED path
 * (`summarize: true`) needs a real model to generate a `BranchSummaryEntry`'s text — that one
 * live call lives in `scripts/session-tree-demo.ts`, not here. This file does still prove
 * `summarize: true`'s pre-flight validation, which is pure and synchronous.
 */

const CWD = "lab-11-mechanics-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-11-mechanics-"));
  const resolved = builtinModels().getModel("deepseek", "deepseek-v4-flash");
  if (!resolved) {
    throw new Error("deepseek/deepseek-v4-flash is missing from the builtin catalog");
  }
  model = resolved;
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

function fakeUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string, totalTokens: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: fakeUsage(totalTokens),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function buildLane() {
  const repo = createSessionRepo(sessionsRoot);
  const models = builtinModels();
  const { session } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
  const { harness } = await AgentHarness.create({ session, models, model, tools: [] }, BACKGROUND_CONTEXT);
  const lane = await harness.lane("main", BACKGROUND_CONTEXT);
  return { session, lane, harness, repo };
}

/** One completed "turn": a user entry followed by an assistant entry, mirroring what a real
 * `lane.prompt()` run would append, without starting a run or calling a model. Returns the
 * assistant entry's id — the only kind of entry `navigateTree()` treats as a valid,
 * non-root target (see the vocabulary note in the README: `toolResult` entries are excluded). */
async function seedTurn(
  lane: Awaited<ReturnType<typeof buildLane>>["lane"],
  userText: string,
  assistantText: string,
): Promise<string> {
  await lane.appendMessage(userMessage(userText), BACKGROUND_CONTEXT);
  return lane.appendMessage(assistantMessage(assistantText, 50), BACKGROUND_CONTEXT);
}

describe("navigateTree mechanics (unsummarized, no live model)", () => {
  it("moves the lane's tip to the target; nothing is deleted from the whole tree even though the lane's own ancestry view now shows less", async () => {
    const { session, lane, harness, repo } = await buildLane();

    const branchPointId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");
    const branchATipId = await seedTurn(lane, "Check its container events.", "Departed on schedule.");

    // `AgentLane.findEntries()` defaults `start` to the lane's OWN current tip and walks
    // backward through parentId — it is an ancestry view, not a whole-tree view.
    // `Session.findEntries()` has no such default; it scans every entry storage has ever
    // written (see `src/tree-view.ts`'s doc comment). Both matter here for different reasons.
    const wholeTreeBefore = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    expect(wholeTreeBefore).toHaveLength(4);
    const laneViewBefore = await lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(laneViewBefore).toHaveLength(4);

    const result = await lane.navigateTree(branchPointId, undefined, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.navigation.status).toBe("completed");
    expect(result.value.navigation.fromTipId).toBe(branchATipId);
    expect(result.value.navigation.tipId).toBe(branchPointId);

    await expect(lane.getTipId(BACKGROUND_CONTEXT)).resolves.toBe(branchPointId);

    // Nothing was deleted from the underlying storage: the whole tree is still all 4 entries,
    // same ids as before.
    const wholeTreeAfter = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    expect(wholeTreeAfter).toHaveLength(4);
    expect(wholeTreeAfter.map((entry) => entry.id).toSorted()).toEqual(wholeTreeBefore.map((entry) => entry.id).toSorted());

    // But the lane's own ancestry view, from its NEW tip, now only sees 2 — branch A's two
    // entries are simply no longer ancestors of the current tip, not gone from the session.
    const laneViewAfter = await lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(laneViewAfter).toHaveLength(2);
    expect(laneViewAfter.some((entry) => entry.id === branchATipId)).toBe(false);

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("lets a new turn parent off the new tip, creating a second leaf beside the original one", async () => {
    const { session, lane, harness, repo } = await buildLane();

    const branchPointId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");
    const branchATipId = await seedTurn(lane, "Check its container events.", "Departed on schedule.");

    await lane.navigateTree(branchPointId, undefined, BACKGROUND_CONTEXT);
    const branchBTipId = await seedTurn(
      lane,
      "Actually I meant BK1002. Look it up instead.",
      "BK1002 uses vessel MAERSK SECOND.",
    );

    const allEntries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    expect(allEntries).toHaveLength(6);

    const tips = findBranchTips(allEntries);
    expect(tips.toSorted()).toEqual([branchATipId, branchBTipId].toSorted());

    const branchPointChildren = allEntries.filter((entry) => entry.parentId === branchPointId);
    expect(branchPointChildren).toHaveLength(2);

    // The original branch-A tip entry is still there, byte for byte — it is simply no longer a
    // leaf once we forked a sibling at its parent. Navigating away never touched it.
    const originalATip = allEntries.find((entry) => entry.id === branchATipId);
    expect(originalATip?.type).toBe("message");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("navigateTree({label}) persists a label on the target, readable via harness.getLabel", async () => {
    const { lane, harness, repo } = await buildLane();

    const branchPointId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");
    await seedTurn(lane, "Check its container events.", "Departed on schedule.");

    await expect(harness.getLabel(branchPointId, BACKGROUND_CONTEXT)).resolves.toBeUndefined();

    const result = await lane.navigateTree(branchPointId, { label: "after-bk1001-lookup" }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);

    await expect(harness.getLabel(branchPointId, BACKGROUND_CONTEXT)).resolves.toBe("after-bk1001-lookup");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("harness.setLabel/getLabel work independently of navigateTree", async () => {
    const { lane, harness, repo } = await buildLane();

    const entryId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    await harness.setLabel(entryId, "first-lookup", BACKGROUND_CONTEXT);
    await expect(harness.getLabel(entryId, BACKGROUND_CONTEXT)).resolves.toBe("first-lookup");

    await harness.setLabel(entryId, undefined, BACKGROUND_CONTEXT);
    await expect(harness.getLabel(entryId, BACKGROUND_CONTEXT)).resolves.toBeUndefined();

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("rejects navigating to the current tip", async () => {
    const { lane, harness, repo } = await buildLane();
    const tipId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    const result = await lane.navigateTree(tipId, undefined, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error._tag !== "InvalidNavigation") throw new Error("unreachable");
    expect(result.error.reason).toBe("current_tip");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("rejects navigating to an unknown target", async () => {
    const { lane, harness, repo } = await buildLane();
    await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    const result = await lane.navigateTree("entry-does-not-exist", undefined, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error._tag).toBe("UnknownTarget");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("rejects labeling the root when navigating to it", async () => {
    const { lane, harness, repo } = await buildLane();
    await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    const result = await lane.navigateTree(null, { label: "root" }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error._tag !== "InvalidNavigation") throw new Error("unreachable");
    expect(result.error.reason).toBe("root_label");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("navigating to root (null) moves the tip to null and lets a new turn start a third, independent root branch", async () => {
    const { session, lane, harness, repo } = await buildLane();

    const branchPointId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    const result = await lane.navigateTree(null, undefined, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.navigation.tipId).toBeNull();
    await expect(lane.getTipId(BACKGROUND_CONTEXT)).resolves.toBeNull();

    const rootBranchTipId = await seedTurn(lane, "Forget BK1001 entirely. Look up BK1002 instead.", "BK1002 uses vessel MAERSK SECOND.");

    const allEntries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    const rootEntries = allEntries.filter((entry) => entry.parentId === null);
    // Two genuinely independent roots now exist: the original first turn, and the new one
    // started fresh after navigating to root.
    const rootUserEntries = rootEntries.filter((entry) => entry.type === "message" && entry.message.role === "user");
    expect(rootUserEntries).toHaveLength(2);
    expect(findBranchTips(allEntries).toSorted()).toEqual([branchPointId, rootBranchTipId].toSorted());

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });
});

describe("navigateTree({summarize: true}) pre-flight validation (pure, no live model)", () => {
  it("rejects a summarized navigation targeting root", async () => {
    const { lane, harness, repo } = await buildLane();
    await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");

    const result = await lane.navigateTree(null, { summarize: true }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error._tag !== "InvalidNavigation") throw new Error("unreachable");
    expect(result.error.reason).toBe("target_root");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("rejects a summarized navigation from a root (null) source tip", async () => {
    const { lane, harness, repo } = await buildLane();
    const firstTipId = await seedTurn(lane, "Look up booking BK1001.", "BK1001 uses vessel MAERSK TEST.");
    await seedTurn(lane, "Check its container events.", "Departed on schedule.");

    // Navigate to root first so the OBSERVED current tip is null — that is what triggers the
    // "source_root" guard, not merely having visited root at some earlier point.
    await lane.navigateTree(null, undefined, BACKGROUND_CONTEXT);
    await expect(lane.getTipId(BACKGROUND_CONTEXT)).resolves.toBeNull();

    const result = await lane.navigateTree(firstTipId, { summarize: true }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error._tag !== "InvalidNavigation") throw new Error("unreachable");
    expect(result.error.reason).toBe("source_root");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });
});
