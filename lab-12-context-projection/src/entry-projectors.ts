import { createCustomMessage, type AgentMessage, type Context, type CustomEntry, type EntryProjector } from "@earendil-works/pi-agent-core";

import { CASE_NOTE_CUSTOM_TYPE, parseCaseNoteData } from "./case-note-entries.js";

/**
 * The one sanitization boundary this lab is about. Pi calls this once per durable `custom`
 * entry whose `customType` matches this map's key (`buildSessionContext()` — see the README's
 * API note); an entry whose `customType` has no matching key here never reaches this function
 * at all and contributes zero context messages, which is indistinguishable from an
 * `"internal"` note that DOES reach here and is deliberately turned away below.
 *
 * `note.internalOnly` is read nowhere in this function. That is not an oversight to be caught
 * by review — it is the actual mechanism: a field that is never referenced when building the
 * approved `AgentMessage` cannot leak through it, regardless of `visibility`.
 */
export const projectCaseNote: EntryProjector = (entry: CustomEntry, _context: Context): AgentMessage[] | undefined => {
  const note = parseCaseNoteData(entry.data);

  if (note.visibility === "internal") {
    return undefined;
  }

  const approvedText = `Case note ${note.noteId} on booking ${note.bookingNo} (from ${note.author}): ${note.text}`;

  return [
    createCustomMessage(
      CASE_NOTE_CUSTOM_TYPE,
      approvedText,
      true,
      { noteId: note.noteId, bookingNo: note.bookingNo },
      entry.timestamp,
    ),
  ];
};

export const entryProjectors: Record<string, EntryProjector> = {
  [CASE_NOTE_CUSTOM_TYPE]: projectCaseNote,
};
