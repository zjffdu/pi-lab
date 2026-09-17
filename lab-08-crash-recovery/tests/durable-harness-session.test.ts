import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

/**
 * These tests exercise the full Session -> AgentHarness -> lane stack from the roadmap's
 * mental model, entirely deterministically: `lane.appendMessage()` writes a durable
 * message entry directly, the same way a completed LLM turn would, without starting a
 * "run" operation or calling any model provider. That lets close/reopen, continuation,
 * and isolation all be proven with no network access and no live model credentials.
 */

const CWD = "lab-08-harness-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-08-harness-"));
  const resolved = builtinModels().getModel("deepseek", "deepseek-v4-flash");
  if (!resolved) {
    throw new Error("deepseek/deepseek-v4-flash is missing from the builtin catalog");
  }
  model = resolved;
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe("durable AgentHarness session", () => {
  it("keeps a completed entry, its branch tip, and its chain across a close/reopen cycle", async () => {
    const repo = createSessionRepo(sessionsRoot);
    const models = builtinModels();

    const { session: session1 } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    const { harness: harness1, open: openOnFirstAttach } = await AgentHarness.create(
      { session: session1, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    expect(openOnFirstAttach).toEqual([]);

    const lane1 = await harness1.lane("main", BACKGROUND_CONTEXT);
    expect(await lane1.getTipId(BACKGROUND_CONTEXT)).toBeNull();

    const entryId1 = await lane1.appendMessage(
      { role: "user", content: "What are the details for booking BK1001?", timestamp: Date.now() },
      BACKGROUND_CONTEXT,
    );
    expect(await lane1.getTipId(BACKGROUND_CONTEXT)).toBe(entryId1);

    // Close the harness (and, transitively, the session) the same way the CLI does at the
    // end of one process's run.
    await harness1.close(BACKGROUND_CONTEXT);

    // Reopen from scratch: a new Session handle from the repo, a brand-new AgentHarness
    // instance, and a fresh call to acquire the "main" lane.
    const { session: session2, created } = await openOrCreateSession(
      repo,
      "conversation-a",
      CWD,
      BACKGROUND_CONTEXT,
    );
    expect(created).toBe(false);

    const { harness: harness2, open: openOnReopen } = await AgentHarness.create(
      { session: session2, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    // No operation was ever started (only a direct appendMessage), so nothing was left
    // "in flight" for the harness to report as open on reattachment.
    expect(openOnReopen).toEqual([]);

    const lane2 = await harness2.lane("main", BACKGROUND_CONTEXT);

    // The branch tip survived the restart untouched.
    expect(await lane2.getTipId(BACKGROUND_CONTEXT)).toBe(entryId1);

    const entriesAfterReopen = await lane2.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entriesAfterReopen).toHaveLength(1);
    expect(entriesAfterReopen[0]?.id).toBe(entryId1);

    // Continuing the session appends onto the restored tip, not a fresh root.
    const entryId2 = await lane2.appendMessage(
      { role: "user", content: "Which container is it using?", timestamp: Date.now() },
      BACKGROUND_CONTEXT,
    );
    expect(entryId2).not.toBe(entryId1);

    const entriesAfterContinuation = await lane2.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entriesAfterContinuation).toHaveLength(2);
    const second = entriesAfterContinuation.find((entry) => entry.id === entryId2);
    expect(second?.parentId).toBe(entryId1);

    // Reopening never duplicated the first entry.
    const firstOccurrences = entriesAfterContinuation.filter((entry) => entry.id === entryId1);
    expect(firstOccurrences).toHaveLength(1);

    await harness2.close(BACKGROUND_CONTEXT);
  });

  it("keeps a different session id fully isolated from another session's entries", async () => {
    const repo = createSessionRepo(sessionsRoot);
    const models = builtinModels();

    const { session: sessionA } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    const { harness: harnessA } = await AgentHarness.create(
      { session: sessionA, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    const laneA = await harnessA.lane("main", BACKGROUND_CONTEXT);
    await laneA.appendMessage(
      { role: "user", content: "What are the details for booking BK1001?", timestamp: Date.now() },
      BACKGROUND_CONTEXT,
    );
    await harnessA.close(BACKGROUND_CONTEXT);

    const { session: sessionB, created } = await openOrCreateSession(
      repo,
      "conversation-b",
      CWD,
      BACKGROUND_CONTEXT,
    );
    expect(created).toBe(true);

    const { harness: harnessB } = await AgentHarness.create(
      { session: sessionB, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    const laneB = await harnessB.lane("main", BACKGROUND_CONTEXT);

    expect(await laneB.getTipId(BACKGROUND_CONTEXT)).toBeNull();
    expect(await laneB.findEntries(undefined, BACKGROUND_CONTEXT)).toEqual([]);

    await harnessB.close(BACKGROUND_CONTEXT);
  });
});
