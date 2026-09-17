import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

/**
 * Same Lab-07/08-style deterministic proof, kept as this lab's network-free baseline:
 * `lane.appendMessage()` writes a durable message entry directly, without starting a "run"
 * operation or calling any model provider, so close/reopen and `open: []` on a session that
 * never left an operation in flight can both be proven without live model credentials. This
 * is the contrast case for what section 4's live crash demo proves instead: that `open`
 * becomes non-empty exactly when a real operation was interrupted mid-flight.
 */

const CWD = "lab-09-harness-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-09-harness-"));
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
  it("reports no open operations for a session that only ever received appendMessage()", async () => {
    const repo = createSessionRepo(sessionsRoot);
    const models = builtinModels();

    const { session: session1 } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    const { harness: harness1, open: openOnFirstAttach } = await AgentHarness.create(
      { session: session1, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    expect(openOnFirstAttach).toEqual([]);

    const lane1 = await harness1.lane("main", BACKGROUND_CONTEXT);
    const entryId1 = await lane1.appendMessage(
      { role: "user", content: "Please place a hold on booking BK1001 for customs review.", timestamp: Date.now() },
      BACKGROUND_CONTEXT,
    );
    expect(await lane1.getTipId(BACKGROUND_CONTEXT)).toBe(entryId1);

    await harness1.close(BACKGROUND_CONTEXT);

    const { session: session2 } = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    const { harness: harness2, open: openOnReopen } = await AgentHarness.create(
      { session: session2, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    // No operation was ever started, so nothing was left "in flight" to report as open —
    // this is what makes a non-empty `open` in the live crash demo meaningful evidence
    // rather than noise.
    expect(openOnReopen).toEqual([]);

    const lane2 = await harness2.lane("main", BACKGROUND_CONTEXT);
    expect(await lane2.getTipId(BACKGROUND_CONTEXT)).toBe(entryId1);

    await harness2.close(BACKGROUND_CONTEXT);
  });
});
