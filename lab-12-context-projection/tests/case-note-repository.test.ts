import { describe, expect, it } from "vitest";

import { CaseNoteRepository } from "../src/case-note-repository.js";

describe("CaseNoteRepository", () => {
  const repository = CaseNoteRepository.fromDefaultFixture();

  it("loads all three fixture notes", () => {
    expect(repository.all()).toHaveLength(3);
  });

  it("filters to BK1001's two notes — one shared, one internal", () => {
    const notes = repository.findByBookingNo("BK1001");
    expect(notes.map((note) => note.noteId).toSorted()).toEqual(["CN-001", "CN-002"]);
    expect(notes.map((note) => note.visibility).toSorted()).toEqual(["internal", "shared"]);
  });

  it("returns an empty array for a booking with no notes", () => {
    expect(repository.findByBookingNo("BK9999")).toEqual([]);
  });

  it("every fixture note's internalOnly field is present and non-empty — the fixture is not testing an already-vacuous case", () => {
    for (const note of repository.all()) {
      expect(typeof note.internalOnly).toBe("string");
      expect((note.internalOnly ?? "").length).toBeGreaterThan(0);
    }
  });
});
