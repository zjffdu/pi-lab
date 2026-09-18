import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness, type CustomEntry } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendCaseNoteEntry, type CaseNoteData } from "../src/case-note-entries.js";
import { projectCaseNote } from "../src/entry-projectors.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

/**
 * Deterministic, network-free proof of `projectCaseNote()` itself — the one function this
 * lab's `entryProjectors` map delegates to. Pi's own `buildSessionContext()` (see the README's
 * API note) is what actually calls a registered projector once per matching custom entry, in
 * path order, and treats an *unregistered* customType identically to a projector returning
 * `undefined` — zero context messages either way. That whole-tree wiring is Pi's own tested
 * behavior, not this lab's; what this file proves is narrower and squarely this lab's
 * responsibility: given one durable `case_note` entry, does `projectCaseNote()` make the
 * right shared/internal decision, and does it ever leak `internalOnly`.
 */

const CWD = "lab-12-projectors-test-group";

let sessionsRoot: string;
let model: Model<Api>;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-12-projectors-"));
  const resolved = builtinModels().getModel("deepseek", "deepseek-v4-flash");
  if (!resolved) {
    throw new Error("deepseek/deepseek-v4-flash is missing from the builtin catalog");
  }
  model = resolved;
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

function fakeCustomEntry(data: CaseNoteData): CustomEntry {
  return {
    id: "entry-fake",
    parentId: null,
    seq: 1,
    timestamp: Date.now(),
    type: "custom",
    customType: "case_note",
    data: data as unknown as CustomEntry["data"],
  };
}

const SHARED_NOTE: CaseNoteData = {
  noteId: "CN-shared-1",
  bookingNo: "BK1001",
  author: "test-author",
  visibility: "shared",
  text: "Customer asked for an ETA update.",
  internalOnly: "SECRET-DISCOUNT-9911",
};

const INTERNAL_NOTE: CaseNoteData = {
  noteId: "CN-internal-1",
  bookingNo: "BK1001",
  author: "test-author-2",
  visibility: "internal",
  text: "Escalation risk on this lane.",
  internalOnly: "SECRET-ESCALATION-7788",
};

describe("projectCaseNote (network-free, direct)", () => {
  it("omits an internal-visibility note entirely — undefined, not an empty-content message", async () => {
    const projected = await projectCaseNote(fakeCustomEntry(INTERNAL_NOTE), BACKGROUND_CONTEXT);
    expect(projected).toBeUndefined();
  });

  it("projects a shared-visibility note as exactly one custom-role AgentMessage", async () => {
    const projected = await projectCaseNote(fakeCustomEntry(SHARED_NOTE), BACKGROUND_CONTEXT);
    expect(projected).toHaveLength(1);
    expect(projected?.[0]?.role).toBe("custom");
  });

  it("sanitizes: a shared note's internalOnly field never appears in the projected message, even though its own text does", async () => {
    const projected = await projectCaseNote(fakeCustomEntry(SHARED_NOTE), BACKGROUND_CONTEXT);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain(SHARED_NOTE.text);
    expect(serialized).toContain(SHARED_NOTE.noteId);
    expect(serialized).not.toContain(SHARED_NOTE.internalOnly);
  });
});

describe("projection after session reopen (network-free)", () => {
  it("re-fetching a shared and an internal note after a close/reopen still projects each correctly", async () => {
    const repo = createSessionRepo(sessionsRoot);
    const models = builtinModels();

    const { session: firstOpen } = await openOrCreateSession(repo, "case-b", CWD, BACKGROUND_CONTEXT);
    const { harness: firstHarness } = await AgentHarness.create(
      { session: firstOpen, models, model, tools: [] },
      BACKGROUND_CONTEXT,
    );
    const firstLane = await firstHarness.lane("main", BACKGROUND_CONTEXT);

    const sharedId = await appendCaseNoteEntry(firstLane, SHARED_NOTE, BACKGROUND_CONTEXT);
    const internalId = await appendCaseNoteEntry(firstLane, INTERNAL_NOTE, BACKGROUND_CONTEXT);

    await firstHarness.close(BACKGROUND_CONTEXT);

    const { session: reopened } = await openOrCreateSession(repo, "case-b", CWD, BACKGROUND_CONTEXT);
    const entries = await reopened.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);

    const sharedEntry = entries.find((entry) => entry.id === sharedId);
    const internalEntry = entries.find((entry) => entry.id === internalId);
    if (!sharedEntry || sharedEntry.type !== "custom") throw new Error("unreachable");
    if (!internalEntry || internalEntry.type !== "custom") throw new Error("unreachable");

    const sharedProjected = await projectCaseNote(sharedEntry, BACKGROUND_CONTEXT);
    const internalProjected = await projectCaseNote(internalEntry, BACKGROUND_CONTEXT);

    expect(internalProjected).toBeUndefined();
    expect(sharedProjected).toHaveLength(1);
    const serialized = JSON.stringify(sharedProjected);
    expect(serialized).toContain(SHARED_NOTE.text);
    expect(serialized).not.toContain(SHARED_NOTE.internalOnly);
    expect(serialized).not.toContain(INTERNAL_NOTE.internalOnly);

    await reopened.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  });
});
