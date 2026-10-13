import { readFileSync } from "node:fs";

import { type CaseNoteData, isCaseNoteData } from "./case-note-entries.js";

export class CaseNoteRepository {
  public constructor(private readonly notes: readonly CaseNoteData[]) {}

  public static fromDefaultFixture(): CaseNoteRepository {
    const fixtureUrl = new URL("../data/case-notes.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

    if (!Array.isArray(parsed) || !parsed.every(isCaseNoteData)) {
      throw new Error("data/case-notes.json does not contain a valid case-note array");
    }

    return new CaseNoteRepository(parsed);
  }

  public all(): readonly CaseNoteData[] {
    return this.notes;
  }

  public findByBookingNo(bookingNo: string): CaseNoteData[] {
    return this.notes.filter((note) => note.bookingNo === bookingNo);
  }
}
