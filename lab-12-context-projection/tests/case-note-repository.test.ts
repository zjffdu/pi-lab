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

  it("every note carries a non-empty internalOnly value, so the fixture is not testing a vacuous case", () => {
    for (const note of repository.all()) {
      expect((note.internalOnly ?? "").length).toBeGreaterThan(0);
    }
  });

  it("no internalOnly value appears inside any note's own text", () => {
    for (const note of repository.all()) {
      expect(note.text).not.toContain(note.internalOnly ?? "");
    }
  });
});
