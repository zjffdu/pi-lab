import { describe, expect, it } from "vitest";

import { appendCaseNote, CaseNote, type CaseNoteData, isCaseNoteData, projectCaseNote } from "../src/case-note-entries.js";
import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { listEntries, messageText } from "../src/transcript.js";
import { createFauxModels, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

const SHARED: CaseNoteData = {
  noteId: "CN-shared-1",
  bookingNo: "BK1001",
  author: "test-author",
  visibility: "shared",
  text: "Customer asked for an ETA update.",
  internalOnly: "SECRET-DISCOUNT-9911",
};

const INTERNAL: CaseNoteData = {
  noteId: "CN-internal-1",
  bookingNo: "BK1001",
  author: "test-author-2",
  visibility: "internal",
  text: "Escalation risk on this lane.",
  internalOnly: "SECRET-ESCALATION-7788",
};

describe("isCaseNoteData", () => {
  it("accepts a well-formed note with or without internalOnly", () => {
    expect(isCaseNoteData(SHARED)).toBe(true);
    const { internalOnly: _omitted, ...withoutInternalOnly } = SHARED;
    expect(isCaseNoteData(withoutInternalOnly)).toBe(true);
  });

  it("rejects a visibility outside shared|internal, a missing field, and a non-string internalOnly", () => {
    expect(isCaseNoteData({ ...SHARED, visibility: "public" })).toBe(false);
    const { text: _omitted, ...withoutText } = SHARED;
    expect(isCaseNoteData(withoutText)).toBe(false);
    expect(isCaseNoteData({ ...SHARED, internalOnly: 7 })).toBe(false);
    expect(isCaseNoteData(null)).toBe(false);
  });
});

describe("projectCaseNote (pure, no harness)", () => {
  it("returns undefined for an internal note — nothing, not an empty message", () => {
    expect(projectCaseNote(INTERNAL)).toBeUndefined();
  });

  it("returns exactly one user message for a shared note", () => {
    const projected = projectCaseNote(SHARED, 123);
    expect(projected).toHaveLength(1);
    expect(projected?.[0]).toMatchObject({ role: "user", timestamp: 123 });
    expect(messageText(projected![0]!)).toBe(
      "Case note CN-shared-1 on booking BK1001 (from test-author): Customer asked for an ETA update.",
    );
  });

  it("sanitizes: the note's own text is projected and its internalOnly value is not, in any field", () => {
    const serialized = JSON.stringify(projectCaseNote(SHARED));
    expect(serialized).toContain(SHARED.text);
    expect(serialized).not.toContain(SHARED.internalOnly);
  });

  it("is deterministic: the same note projects to the same text every time", () => {
    expect(JSON.stringify(projectCaseNote(SHARED, 1))).toBe(JSON.stringify(projectCaseNote(SHARED, 1)));
  });
});

describe("appendCaseNote", () => {
  it("writes the same data under both policies; only `model` differs", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "notes", ctx);
      const { harness, root } = await openHarness(storage, { models, selection }, ctx);

      const durableOnly = await appendCaseNote(root, SHARED, "durable-only", ctx);
      const projected = await appendCaseNote(root, SHARED, "projected", ctx);
      const internalProjected = await appendCaseNote(root, INTERNAL, "projected", ctx);

      expect(durableOnly.kind).toBe("app.case_note");
      expect(durableOnly.data).toEqual(SHARED);
      expect(durableOnly.model).toBeUndefined();

      expect(projected.data).toEqual(SHARED);
      expect(projected.model).toHaveLength(1);

      // A "projected" write of an internal note is still durable-only: the projection function declines it.
      expect(internalProjected.data).toEqual(INTERNAL);
      expect(internalProjected.model).toBeUndefined();

      await harness.close(ctx);
    }));

  it("is a plain entry, not a submission: no run, no task, nothing unsettled", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "notes", ctx);
      const { harness, root } = await openHarness(storage, { models, selection }, ctx);

      await appendCaseNote(root, SHARED, "projected", ctx);
      const inspection = await harness.inspect(ctx);
      expect(inspection.tasks).toHaveLength(0);
      expect(inspection.submissions).toHaveLength(0);

      await harness.close(ctx);
    }));

  it("survives closing the storage and reopening it, byte for byte, with and without a model message", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const first = await openSessionStorage(sessionsRoot, "notes", ctx);
      const opened = await openHarness(first.storage, { models, selection }, ctx);
      await appendCaseNote(opened.root, SHARED, "projected", ctx);
      await appendCaseNote(opened.root, INTERNAL, "durable-only", ctx);
      await opened.harness.close(ctx);

      const second = await openSessionStorage(sessionsRoot, "notes", ctx);
      expect(second.created).toBe(false);
      const reopened = await openHarness(second.storage, { models, selection }, ctx);

      const notes = (await listEntries(reopened.root, ctx)).filter(CaseNote.is);
      expect(notes.map((note) => note.data)).toEqual([SHARED, INTERNAL]);
      expect(notes.map((note) => note.model?.length ?? 0)).toEqual([1, 0]);

      await reopened.harness.close(ctx);
    }));
});
