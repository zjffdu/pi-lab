import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { type Conversation, defineEntry, type EntryRecord, type TypedEntry } from "@earendil-works/pi-durable";

export const CASE_NOTE_KIND = "app.case_note";

export type CaseNoteVisibility = "shared" | "internal";

/**
 * A `type` alias, not an `interface`: a type alias is assignable to the JSON value type that
 * `EntryRecord.data` requires, an interface is not.
 */
export type CaseNoteData = {
  noteId: string;
  bookingNo: string;
  author: string;
  visibility: CaseNoteVisibility;
  text: string;
  /**
   * Durable, in `data` only. `projectCaseNote()` never reads it, so it can never reach `model`, and a
   * `model` that is absent or sanitized is the only thing a request is built from. It exists on notes
   * of BOTH visibilities: the interesting case is a `"shared"` note whose `text` is approved for the
   * model while this field is not.
   */
  internalOnly?: string;
};

/** Typed entry kind. `CaseNote.is(entry)` narrows an `EntryRecord` to one whose `data` is `CaseNoteData`. */
export const CaseNote = defineEntry<CaseNoteData>(CASE_NOTE_KIND);

export function isCaseNoteData(value: unknown): value is CaseNoteData {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.noteId === "string" &&
    typeof candidate.bookingNo === "string" &&
    typeof candidate.author === "string" &&
    (candidate.visibility === "shared" || candidate.visibility === "internal") &&
    typeof candidate.text === "string" &&
    (candidate.internalOnly === undefined || typeof candidate.internalOnly === "string")
  );
}

/**
 * The one sanitization boundary this lab is about, and a pure function. An entry's contribution to model
 * context is its `model` field, so this decision runs at WRITE time and is stored in the entry: `model` is
 * the projection, `data` is the record.
 *
 * - `"internal"` note: `undefined`, so the entry is written with no `model` and is durable-only.
 * - `"shared"` note: exactly one user message carrying the note's id, booking, author, and `text`.
 *
 * `note.internalOnly` is read nowhere in this function. That is the mechanism, not an oversight.
 */
export function projectCaseNote(note: CaseNoteData, timestamp: number = Date.now()): Message[] | undefined {
  if (note.visibility === "internal") {
    return undefined;
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Case note ${note.noteId} on booking ${note.bookingNo} (from ${note.author}): ${note.text}`,
        },
      ],
      timestamp,
    },
  ];
}

/**
 * How a note is written. Both write exactly the same `data`; only whether the entry also carries `model`
 * differs, and that is the whole difference between "durable only" and "reaches the model".
 *
 * - `"durable-only"`: no `model`, ever. The "no projector" arm of this lab's mental model.
 * - `"projected"`: `model = projectCaseNote(note)`. Shared notes reach the model; internal ones still don't.
 */
export type CaseNoteWritePolicy = "durable-only" | "projected";

/** Appends one durable `app.case_note` entry. It never calls a model and is not a submission: no inbox, no run. */
export async function appendCaseNote(
  conversation: Conversation,
  note: CaseNoteData,
  policy: CaseNoteWritePolicy,
  context: Context,
): Promise<TypedEntry<CaseNoteData>> {
  const model = policy === "projected" ? projectCaseNote(note) : undefined;
  return conversation.commit(
    (tx) => tx.appendEntry(CaseNote, conversation.id, model === undefined ? { data: note } : { data: note, model }),
    context,
  );
}

/**
 * Appends an entry whose only job is to take an earlier entry's projection back out of model context. The
 * target stays in storage, `data` and `model` both; `edits` is a context-only override. This is the 1.1
 * way to change a projection after the fact, since the projection is no longer recomputed on every request.
 */
export async function revokeProjection(
  conversation: Conversation,
  target: EntryRecord["id"],
  context: Context,
): Promise<EntryRecord> {
  return conversation.commit(
    (tx) => tx.appendEntry(conversation.id, { kind: "app.projection_revoked", edits: [{ target, action: "omit" }] }),
    context,
  );
}
