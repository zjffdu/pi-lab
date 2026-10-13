import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryId, TypedEntry } from "@earendil-works/pi-durable";

import { CaseNote, type CaseNoteData } from "./case-note-entries.js";
import type { ProviderBoundary } from "./provider-boundary.js";
import { listEntries } from "./transcript.js";

export interface CaseNoteEvidence {
  entryId: EntryId;
  noteId: string;
  visibility: CaseNoteData["visibility"];
  /** Messages stored in the entry's own `model` field: what the entry offers to model context. */
  storedModelMessages: number;
  /** Messages the entry actually contributes to the conversation's NEXT request, after edits. */
  contributedMessages: number;
}

/** Every case-note entry the conversation can see, oldest first, read from durable storage. */
export async function listCaseNotes(
  conversation: Conversation,
  context: Context,
): Promise<TypedEntry<CaseNoteData>[]> {
  return (await listEntries(conversation, context)).filter(CaseNote.is);
}

/**
 * One row per durable case note: what it stores in `model` and what it contributes to the next request.
 * The two differ exactly when an `edits` entry has taken a projection back out, and both are 0 for a note
 * written durable-only. Entry ids and counts only — never a note's text or its `internalOnly` value.
 */
export async function caseNoteEvidence(conversation: Conversation, context: Context): Promise<CaseNoteEvidence[]> {
  const view = await conversation.context(context);
  const notes = await listCaseNotes(conversation, context);

  return notes.map((note) => {
    const position = view.entries.findIndex((entry) => entry.id === note.id);
    return {
      entryId: note.id,
      noteId: note.data.noteId,
      visibility: note.data.visibility,
      storedModelMessages: note.model?.length ?? 0,
      contributedMessages: position === -1 ? 0 : (view.contributions[position]?.length ?? 0),
    };
  });
}

/**
 * Registers every `internalOnly` value found in the session's durable case notes as a text that must never
 * reach a provider. The forbidden list is derived from durable data, so it is correct after a restart
 * without anyone re-supplying the secrets. Returns how many notes carried one.
 */
export async function forbidInternalOnlyValues(
  conversation: Conversation,
  boundary: ProviderBoundary,
  context: Context,
): Promise<number> {
  const values = (await listCaseNotes(conversation, context)).flatMap((note) =>
    note.data.internalOnly === undefined ? [] : [note.data.internalOnly],
  );
  boundary.forbid(...values);
  return values.length;
}
