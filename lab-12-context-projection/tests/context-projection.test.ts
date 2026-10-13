import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { caseNoteEvidence, forbidInternalOnlyValues, listCaseNotes } from "../src/case-note-evidence.js";
import { appendCaseNote, CASE_NOTE_KIND, type CaseNoteData, revokeProjection } from "../src/case-note-entries.js";
import { CaseNoteRepository } from "../src/case-note-repository.js";
import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { createProviderBoundary } from "../src/provider-boundary.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { answerAndRecord, createFauxModels, plainText, withTempSessionsRoot } from "./helpers.js";

/**
 * Network-free proof of what reaches a provider request. Two independent observers agree on every claim:
 * `Conversation.context()` (the committed model context the NEXT request is built from, with the entries
 * that contributed to it) and the transcript the scripted provider actually received (`answerAndRecord`).
 */

const ctx = BACKGROUND_CONTEXT;

const [SHARED, INTERNAL] = CaseNoteRepository.fromDefaultFixture().findByBookingNo("BK1001") as [
  CaseNoteData,
  CaseNoteData,
];
const SECRETS = [SHARED.internalOnly!, INTERNAL.internalOnly!];
const SHARED_PROJECTION = `Case note ${SHARED.noteId} on booking ${SHARED.bookingNo} (from ${SHARED.author}): ${SHARED.text}`;

type Faux = ReturnType<typeof createFauxModels>;

async function openSession(sessionsRoot: string, faux: Faux) {
  const boundary = createProviderBoundary();
  const { storage } = await openSessionStorage(sessionsRoot, "case", ctx);
  const opened = await openHarness(
    storage,
    { models: faux.models, selection: faux.selection, registry: createBookingRegistry({ boundary }) },
    ctx,
  );
  return { ...opened, boundary };
}

async function ask(root: Awaited<ReturnType<typeof openSession>>["root"], content: string) {
  const settled = await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
}

function leaked(messages: readonly Message[]): string[] {
  const text = plainText(messages);
  return SECRETS.filter((secret) => text.includes(secret));
}

describe("a note written durable-only", () => {
  it("is stored, contributes nothing to context, and never reaches the provider", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("noted", requests)]);
      const { harness, root, boundary } = await openSession(sessionsRoot, faux);

      await appendCaseNote(root, SHARED, "durable-only", ctx);
      await appendCaseNote(root, INTERNAL, "durable-only", ctx);
      boundary.forbid(...SECRETS, SHARED.text);

      expect(await caseNoteEvidence(root, ctx)).toEqual([
        expect.objectContaining({ noteId: "CN-001", storedModelMessages: 0, contributedMessages: 0 }),
        expect.objectContaining({ noteId: "CN-002", storedModelMessages: 0, contributedMessages: 0 }),
      ]);
      expect((await root.context(ctx)).messages).toEqual([]);

      await ask(root, "Do you know of any discount?");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.map((message) => message.role)).toEqual(["system", "user"]);
      expect(plainText(requests[0]!)).not.toContain(SHARED.text);
      expect(leaked(requests[0]!)).toEqual([]);
      expect(boundary.violations).toEqual([]);

      await harness.close(ctx);
    }));
});

describe("a note written with its projection", () => {
  it("contributes exactly one message for the shared note and none for the internal one", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("noted", requests)]);
      const { harness, root, boundary } = await openSession(sessionsRoot, faux);

      await appendCaseNote(root, SHARED, "projected", ctx);
      await appendCaseNote(root, INTERNAL, "projected", ctx);
      expect(await forbidInternalOnlyValues(root, boundary, ctx)).toBe(2);
      expect(boundary.forbiddenCount).toBe(2);

      expect(await caseNoteEvidence(root, ctx)).toEqual([
        expect.objectContaining({ noteId: "CN-001", visibility: "shared", storedModelMessages: 1, contributedMessages: 1 }),
        expect.objectContaining({ noteId: "CN-002", visibility: "internal", storedModelMessages: 0, contributedMessages: 0 }),
      ]);

      await ask(root, "Do you know of any discount?");
      expect(requests[0]!.map((message) => message.role)).toEqual(["system", "user", "user"]);
      expect(plainText([requests[0]![1]!])).toBe(SHARED_PROJECTION);
      expect(plainText(requests[0]!)).not.toContain(INTERNAL.text);
      expect(leaked(requests[0]!)).toEqual([]);

      // The guard saw the same request, armed with both secrets, and found neither.
      expect(boundary.requests).toEqual([{ index: 1, messageCount: 3, roles: ["system", "user", "user"] }]);
      expect(boundary.violations).toEqual([]);

      await harness.close(ctx);
    }));

  it("keeps the note where it was written, between the turns around it", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("first answer", requests), answerAndRecord("second answer", requests)]);
      const { harness, root } = await openSession(sessionsRoot, faux);

      await ask(root, "First question.");
      await appendCaseNote(root, SHARED, "projected", ctx);
      await appendCaseNote(root, INTERNAL, "projected", ctx);
      await ask(root, "Second question.");

      expect(requests[1]!.map((message) => message.role)).toEqual(["system", "user", "assistant", "user", "user"]);
      expect(requests[1]!.slice(1).map((message) => plainText([message]))).toEqual([
        "First question.",
        "first answer",
        SHARED_PROJECTION,
        "Second question.",
      ]);

      await harness.close(ctx);
    }));

  it("is exactly the same after the storage is closed and reopened", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("noted", requests)]);

      const first = await openSession(sessionsRoot, faux);
      await appendCaseNote(first.root, SHARED, "projected", ctx);
      await appendCaseNote(first.root, INTERNAL, "projected", ctx);
      const before = await caseNoteEvidence(first.root, ctx);
      await first.harness.close(ctx);

      const second = await openSession(sessionsRoot, faux);
      // The forbidden list is derived from durable data; nobody re-supplies the secrets after a restart.
      expect(await forbidInternalOnlyValues(second.root, second.boundary, ctx)).toBe(2);
      expect(await caseNoteEvidence(second.root, ctx)).toEqual(before);

      await ask(second.root, "Do you know of any discount?");
      expect(requests[0]!.map((message) => message.role)).toEqual(["system", "user", "user"]);
      expect(plainText([requests[0]![1]!])).toBe(SHARED_PROJECTION);
      expect(leaked(requests[0]!)).toEqual([]);
      expect(second.boundary.violations).toEqual([]);

      await second.harness.close(ctx);
    }));
});

describe("the provider boundary as a negative control", () => {
  // A writer that skips the projection function and puts the whole record into `model`. The guard exists to
  // catch exactly this, so the test proves it fires, says where, and does not carry the secret in its report.
  it("records a violation when a note's whole record is written into model context", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("noted", requests)]);
      const { harness, root, boundary } = await openSession(sessionsRoot, faux);

      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, {
            kind: CASE_NOTE_KIND,
            data: SHARED,
            model: [{ role: "user", content: JSON.stringify(SHARED), timestamp: Date.now() }],
          }),
        ctx,
      );
      await forbidInternalOnlyValues(root, boundary, ctx);

      await ask(root, "Do you know of any discount?");

      expect(boundary.violations).toEqual([{ request: 1, messageIndex: 1, role: "user", forbiddenIndex: 0 }]);
      expect(JSON.stringify(boundary.violations)).not.toContain(SHARED.internalOnly);
      // The guard checks and reports; the request still went out unchanged, so it is not a barrier.
      expect(leaked(requests[0]!)).toEqual([SHARED.internalOnly]);

      await harness.close(ctx);
    }));

  it("counts nothing when it was never armed — a guard with an empty forbidden list proves nothing", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      faux.faux.setResponses([answerAndRecord("noted", [])]);
      const { harness, root, boundary } = await openSession(sessionsRoot, faux);

      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, {
            kind: CASE_NOTE_KIND,
            data: SHARED,
            model: [{ role: "user", content: JSON.stringify(SHARED), timestamp: Date.now() }],
          }),
        ctx,
      );
      await ask(root, "Do you know of any discount?");

      expect(boundary.forbiddenCount).toBe(0);
      expect(boundary.violations).toEqual([]);
      expect(boundary.requests).toHaveLength(1);

      await harness.close(ctx);
    }));
});

describe("taking a projection back", () => {
  it("removes the note from context without removing it from storage", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const requests: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("noted", requests)]);
      const { harness, root } = await openSession(sessionsRoot, faux);

      const note = await appendCaseNote(root, SHARED, "projected", ctx);
      expect((await caseNoteEvidence(root, ctx))[0]).toMatchObject({ storedModelMessages: 1, contributedMessages: 1 });

      await revokeProjection(root, note.id, ctx);

      expect((await caseNoteEvidence(root, ctx))[0]).toMatchObject({ storedModelMessages: 1, contributedMessages: 0 });
      const [stored] = await listCaseNotes(root, ctx);
      expect(stored?.data).toEqual(SHARED);
      expect(stored?.model).toHaveLength(1);

      await ask(root, "Do you know of any discount?");
      expect(plainText(requests[0]!)).not.toContain(SHARED.text);
      expect(requests[0]!.map((message) => message.role)).toEqual(["system", "user"]);

      await harness.close(ctx);
    }));
});
