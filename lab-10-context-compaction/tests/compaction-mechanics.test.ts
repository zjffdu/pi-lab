import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentHarness,
  calculateContextTokens,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

/**
 * Deterministic, network-free proof of the compaction mechanism itself. `lane.appendMessage()`
 * writes durable message entries without starting a "run" or calling any model provider (same
 * premise `tests/session-store.test.ts` and Lab 07-09's durability tests use), so a realistic
 * multi-turn transcript can be built and fed straight into `prepareCompaction` — the pure,
 * synchronous function the harness itself calls before it ever asks a model to write a
 * summary. Nothing here exercises `lane.compact()`'s live-model summary generation; that is
 * `scripts/compaction-demo.ts`'s job.
 */

const CWD = "lab-10-mechanics-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-10-mechanics-"));
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

/** Every assistant message needs the harness's own reported per-request `usage` — real
 * `estimateContextTokens` accounting is usage-anchored from the most recent assistant
 * message forward (`getLastAssistantUsage`), not a flat sum, so a synthetic transcript needs
 * a plausible non-zero usage to exercise the same path a live run would. */
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

/** A conversation long enough, in real characters, to force a real compaction cut point once
 * `keepRecentTokens` is small — this mirrors `scripts/compaction-demo.ts`'s seeded turns
 * without needing a live model to generate the assistant text. */
async function seedFiveTurnConversation(): Promise<Awaited<ReturnType<typeof buildLane>>> {
  const { lane, harness, repo } = await buildLane();

  await lane.appendMessage(userMessage("Look up booking BK1001 and tell me its route and vessel."), BACKGROUND_CONTEXT);
  await lane.appendMessage(
    assistantMessage(
      "BK1001 ships container MSKU1234567 from CNSHA to NLRTM on MAERSK TEST, departing 2026-09-10 and arriving 2026-10-15.",
      120,
    ),
    BACKGROUND_CONTEXT,
  );

  await lane.appendMessage(
    userMessage("Now look up booking BK1002 as well. Flag anything unusual before we proceed."),
    BACKGROUND_CONTEXT,
  );
  await lane.appendMessage(
    assistantMessage(
      "BK1002 ships container MSKU7654321 from SGSIN to USLAX on MAERSK SECOND. One thing to flag: it has a " +
        "customs hold — reason: missing phytosanitary certificate.",
      140,
    ),
    BACKGROUND_CONTEXT,
  );

  await lane.appendMessage(userMessage("Check the container movement events for MSKU1234567."), BACKGROUND_CONTEXT);
  await lane.appendMessage(
    assistantMessage("MSKU1234567: GATE_IN 2026-09-09, LOAD 2026-09-10, DEPARTURE 2026-09-10 — all at CNSHA.", 100),
    BACKGROUND_CONTEXT,
  );

  await lane.appendMessage(
    userMessage("Given what you know so far, which booking looks more time-sensitive, and why?"),
    BACKGROUND_CONTEXT,
  );
  await lane.appendMessage(
    assistantMessage(
      "BK1002 looks more time-sensitive: its customs hold could delay departure, and its planned arrival window " +
        "is tighter relative to today than BK1001's.",
      110,
    ),
    BACKGROUND_CONTEXT,
  );

  await lane.appendMessage(
    userMessage("If the customer asks for an ETA update tomorrow, what would you check first?"),
    BACKGROUND_CONTEXT,
  );
  await lane.appendMessage(
    assistantMessage("I would re-check both bookings' latest container events for any new movement or delay signal.", 90),
    BACKGROUND_CONTEXT,
  );

  return { lane, harness, repo };
}

/** `findEntries()` does not promise ordering — `prepareCompaction` needs the chronological
 * root-to-tip path it expects internally, so every direct caller sorts by `seq` itself (the
 * same thing `src/cli.ts` already does before printing). */
function chronological<T extends { seq: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

async function buildLane() {
  const repo = createSessionRepo(sessionsRoot);
  const models = builtinModels();
  const { session } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
  const { harness } = await AgentHarness.create({ session, models, model, tools: [] }, BACKGROUND_CONTEXT);
  const lane = await harness.lane("main", BACKGROUND_CONTEXT);
  return { lane, harness, repo };
}

describe("compaction mechanics (pure functions, no live model)", () => {
  it("calculateContextTokens / shouldCompact behave on plain Usage values", () => {
    const usage = fakeUsage(700);
    expect(calculateContextTokens(usage)).toBe(700);
    // threshold = contextWindow - reserveTokens = 1000 - 400 = 600; 700 > 600.
    expect(shouldCompact(700, 1000, { enabled: true, reserveTokens: 400, keepRecentTokens: 150 })).toBe(true);
    // threshold = 2000 - 400 = 1600; 700 is not over it.
    expect(shouldCompact(700, 2000, { enabled: true, reserveTokens: 400, keepRecentTokens: 150 })).toBe(false);
    expect(shouldCompact(700, 1000, { enabled: false, reserveTokens: 400, keepRecentTokens: 150 })).toBe(false);
  });

  it("estimateContextTokens anchors on the last assistant usage, not a flat character sum", () => {
    const messages: AgentMessage[] = [
      userMessage("hello"),
      assistantMessage("hi there", 42),
      userMessage("a very short follow-up"),
    ];
    const estimate = estimateContextTokens(messages);
    expect(estimate.usageTokens).toBe(42);
    expect(estimate.lastUsageIndex).toBe(1);
    expect(estimate.tokens).toBeGreaterThan(42);
  });

  it("with a large keepRecentTokens budget, nothing is selected for summarization", async () => {
    const { lane, harness, repo } = await seedFiveTurnConversation();
    const entries = chronological(await lane.findEntries(undefined, BACKGROUND_CONTEXT));

    const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(preparation.ok).toBe(true);
    if (preparation.ok && preparation.value) {
      expect(preparation.value.messagesToSummarize).toHaveLength(0);
    }

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("with this lab's tiny keepRecentTokens budget, the early customs-hold turn is selected for summarization, not retained verbatim", async () => {
    const { lane, harness, repo } = await seedFiveTurnConversation();
    const entries = chronological(await lane.findEntries(undefined, BACKGROUND_CONTEXT));

    const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 400, keepRecentTokens: 120 });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok || !preparation.value) {
      throw new Error("expected a real compaction preparation for a long transcript with a tiny keepRecentTokens budget");
    }

    const { messagesToSummarize, retainedTail } = preparation.value;
    expect(messagesToSummarize.length).toBeGreaterThan(0);
    expect(retainedTail.length).toBeGreaterThan(0);
    expect(messagesToSummarize.length + retainedTail.length).toBeLessThanOrEqual(entries.length);

    // "customs hold" alone is too coarse a marker: turn 4's reasoning answer legitimately
    // refers back to it ("its customs hold could delay departure") without repeating the
    // actual fact. "missing phytosanitary certificate" only ever appears once, in turn 2 —
    // that is the specific vulnerable detail this assertion is really about.
    const summarizedText = messagesToSummarize
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    expect(summarizedText).toContain("missing phytosanitary certificate");

    const retainedText = retainedTail
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    expect(retainedText).not.toContain("missing phytosanitary certificate");

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });

  it("prepareCompaction never mutates or drops the underlying durable entries it read", async () => {
    const { lane, harness, repo } = await seedFiveTurnConversation();
    const entriesBefore = chronological(await lane.findEntries(undefined, BACKGROUND_CONTEXT));

    prepareCompaction(entriesBefore, { enabled: true, reserveTokens: 400, keepRecentTokens: 120 });

    const entriesAfter = await lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entriesAfter).toHaveLength(entriesBefore.length);
    expect(entriesAfter.every((entry) => entry.type === "message")).toBe(true);

    await harness.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });
});
