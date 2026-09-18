import type { AgentLane, Context, JsonValue } from "@earendil-works/pi-agent-core";

export const CASE_NOTE_CUSTOM_TYPE = "case_note";

export type CaseNoteVisibility = "shared" | "internal";

export interface CaseNoteData {
  noteId: string;
  bookingNo: string;
  author: string;
  visibility: CaseNoteVisibility;
  text: string;
  /**
   * Durable, but never read by `entry-projectors.ts`'s projector and never allowed through
   * `provider-boundary.ts`'s guard — on ANY note, regardless of `visibility`. This is the one
   * field this lab's failure-injection experiment proves is absent from projected messages,
   * provider messages, and the final answer, even on a `"shared"` note whose `text` field IS
   * meant to reach the model.
   */
  internalOnly?: string;
}

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

export function parseCaseNoteData(data: unknown): CaseNoteData {
  if (!isCaseNoteData(data)) {
    throw new Error(`case_note entry data is not a valid CaseNoteData: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Appends one durable `custom` entry of type `"case_note"`. `AgentLane.appendCustomEntry()`
 * never calls a model and never consults `entryProjectors` — it is a pure write to the
 * session, same premise as `lane.appendMessage()` in earlier labs' tests. Whether this entry
 * ever becomes model-visible is decided entirely at read time, by whichever `entryProjectors`
 * the harness that later opens this lane was configured with — see `entry-projectors.ts` and
 * `create-harness.ts`'s `withCaseNoteProjection` option.
 */
export async function appendCaseNoteEntry(lane: AgentLane, note: CaseNoteData, context: Context): Promise<string> {
  // `note` already came from `JSON.parse` (case-note-repository.ts's fixture load or this
  // lab's CLI parsing raw argv strings) — it is JSON-safe by construction, so this cast is
  // narrowing a concrete interface to the broader `JsonValue` the harness API accepts, not
  // asserting past a real type mismatch.
  return lane.appendCustomEntry(CASE_NOTE_CUSTOM_TYPE, note as unknown as JsonValue, context);
}
