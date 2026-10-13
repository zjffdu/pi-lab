import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { FROZEN_EVALUATION_CASES } from "../src/evaluation-cases.js";

describe("FROZEN_EVALUATION_CASES", () => {
  it("has unique case ids", () => {
    const ids = FROZEN_EVALUATION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every requiredEvidence and expectedEffect booking number that should exist is present in the fixture", () => {
    const repository = BookingRepository.fromDefaultFixture();
    for (const evaluationCase of FROZEN_EVALUATION_CASES) {
      for (const bookingNo of evaluationCase.requiredEvidence) {
        // "unknown-booking" deliberately targets a booking that does not exist; every other
        // case's required evidence must resolve against the real fixture.
        if (evaluationCase.id === "unknown-booking") continue;
        expect(repository.findByBookingNo(bookingNo), `${evaluationCase.id}: ${bookingNo} missing from fixture`).toBeDefined();
      }
      for (const effect of evaluationCase.expectedEffects) {
        expect(repository.findByBookingNo(effect.bookingNo), `${evaluationCase.id}: ${effect.bookingNo} missing from fixture`).toBeDefined();
      }
    }
  });

  it("requiredEvidence and expectedEffects booking numbers are a subset of relevantBookingNos when relevantBookingNos is non-empty", () => {
    for (const evaluationCase of FROZEN_EVALUATION_CASES) {
      if (evaluationCase.relevantBookingNos.length === 0) continue;
      const allowed = new Set(evaluationCase.relevantBookingNos);
      for (const bookingNo of evaluationCase.requiredEvidence) {
        expect(allowed.has(bookingNo), `${evaluationCase.id}: required evidence ${bookingNo} not in relevantBookingNos`).toBe(true);
      }
      for (const effect of evaluationCase.expectedEffects) {
        expect(allowed.has(effect.bookingNo), `${evaluationCase.id}: expected effect ${effect.bookingNo} not in relevantBookingNos`).toBe(true);
      }
    }
  });

  it("the prompt text mentions every booking number in relevantBookingNos, so a learner can trace evidence back to the prompt", () => {
    for (const evaluationCase of FROZEN_EVALUATION_CASES) {
      for (const bookingNo of evaluationCase.relevantBookingNos) {
        expect(evaluationCase.prompt.includes(bookingNo), `${evaluationCase.id}: prompt does not mention ${bookingNo}`).toBe(true);
      }
    }
  });

  it("every container a case must name belongs to one of that case's relevant bookings", () => {
    const repository = BookingRepository.fromDefaultFixture();
    for (const evaluationCase of FROZEN_EVALUATION_CASES) {
      const owned = new Set(
        evaluationCase.relevantBookingNos.flatMap((bookingNo) => repository.findByBookingNo(bookingNo)?.containerNos ?? []),
      );
      for (const containerNo of evaluationCase.mustNameContainerNos) {
        expect(owned.has(containerNo), `${evaluationCase.id}: ${containerNo} is not a container of its relevant bookings`).toBe(true);
      }
    }
  });

  it("includes a case that asks for every container of a multi-container booking", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const multi = repository.all().find((booking) => booking.containerNos.length > 1);
    expect(multi).toBeDefined();
    const covering = FROZEN_EVALUATION_CASES.find((c) => c.relevantBookingNos.includes(multi!.bookingNo) && c.mustNameContainerNos.length === multi!.containerNos.length);
    expect(covering, "no case checks container coverage for the multi-container booking").toBeDefined();
    expect([...covering!.mustNameContainerNos].sort()).toEqual([...multi!.containerNos].sort());
  });

  it("relevantBookingNos includes every booking number the prompt itself names — the reverse direction of the check above", () => {
    // Caught live (see README Findings): a first draft of "unknown-booking" left
    // relevantBookingNos empty, and identifier-provenance then flagged the model's own honest
    // "no booking found for BK9999" as an *invented* identifier — it was only echoing the
    // number the user asked about. A prompt-named booking is always legitimate to echo back,
    // whether or not it resolves to a real fixture entry; this invariant prevents that
    // omission from silently recurring in a future case.
    const bookingNoPattern = /\bBK\d{3,}\b/g;
    for (const evaluationCase of FROZEN_EVALUATION_CASES) {
      const namedInPrompt = [...new Set(evaluationCase.prompt.match(bookingNoPattern) ?? [])];
      for (const bookingNo of namedInPrompt) {
        expect(
          evaluationCase.relevantBookingNos.includes(bookingNo),
          `${evaluationCase.id}: prompt names ${bookingNo} but it is missing from relevantBookingNos`,
        ).toBe(true);
      }
    }
  });
});
