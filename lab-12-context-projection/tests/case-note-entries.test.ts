import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendCaseNoteEntry, isCaseNoteData, parseCaseNoteData, type CaseNoteData } from "../src/case-note-entries.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

const CWD = "lab-12-entries-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-12-entries-"));
  const resolved = builtinModels().getModel("deepseek", "deepseek-v4-flash");
  if (!resolved) {
    throw new Error("deepseek/deepseek-v4-flash is missing from the builtin catalog");
  }
  model = resolved;
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

const SHARED_NOTE: CaseNoteData = {
  noteId: "CN-test-1",
  bookingNo: "BK1001",
  author: "test-author",
  visibility: "shared",
  text: "Customer asked for a status update.",
  internalOnly: "SECRET-TOKEN-1",
};

describe("isCaseNoteData / parseCaseNoteData", () => {
  it("accepts a well-formed note with internalOnly present", () => {
    expect(isCaseNoteData(SHARED_NOTE)).toBe(true);
    expect(parseCaseNoteData(SHARED_NOTE)).toEqual(SHARED_NOTE);
  });

  it("accepts a well-formed note with internalOnly omitted", () => {
    const { internalOnly: _internalOnly, ...withoutInternalOnly } = SHARED_NOTE;
    expect(isCaseNoteData(withoutInternalOnly)).toBe(true);
  });

  it("rejects a visibility value outside shared|internal", () => {
    expect(isCaseNoteData({ ...SHARED_NOTE, visibility: "public" })).toBe(false);
  });

  it("rejects data missing a required field", () => {
    const { text: _text, ...missingText } = SHARED_NOTE;
    expect(isCaseNoteData(missingText)).toBe(false);
  });

  it("parseCaseNoteData throws on malformed data instead of returning a partial object", () => {
    expect(() => parseCaseNoteData({ noteId: "x" })).toThrow();
  });
});

describe("appendCaseNoteEntry (network-free)", () => {
  it("writes a durable custom entry that survives a session close and reopen, byte for byte", async () => {
    const repo = createSessionRepo(sessionsRoot);
    const models = builtinModels();

    const { session: firstOpen } = await openOrCreateSession(repo, "case-a", CWD, BACKGROUND_CONTEXT);
    const { harness: firstHarness } = await AgentHarness.create(
      { session: firstOpen, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    const firstLane = await firstHarness.lane("main", BACKGROUND_CONTEXT);

    const entryId = await appendCaseNoteEntry(firstLane, SHARED_NOTE, BACKGROUND_CONTEXT);

    await firstHarness.close(BACKGROUND_CONTEXT);

    const { session: reopened, created } = await openOrCreateSession(repo, "case-a", CWD, BACKGROUND_CONTEXT);
    expect(created).toBe(false);

    const entries = await reopened.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    const written = entries.find((entry) => entry.id === entryId);
    expect(written).toBeDefined();
    if (!written || written.type !== "custom") throw new Error("unreachable");
    expect(written.customType).toBe("case_note");
    expect(parseCaseNoteData(written.data)).toEqual(SHARED_NOTE);

    await reopened.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });
});
