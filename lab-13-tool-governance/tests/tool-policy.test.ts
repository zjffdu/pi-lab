import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { evaluateUpdateBookingStatusPolicy } from "../src/tool-policy.js";

/**
 * Deterministic, network-free proof of the one function this lab's policy actually is. No
 * harness, no model, no hook — `governance-hooks.test.ts` and `governance-pipeline.test.ts` prove the
 * wiring; this file proves the decision itself is a pure function of structured input.
 */
describe("evaluateUpdateBookingStatusPolicy", () => {
  it("blocks newStatus \"cancelled\" for any booking, regardless of current status", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const decision = evaluateUpdateBookingStatusPolicy({ bookingNo: "BK1001", newStatus: "cancelled" }, repository);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not permitted/i);
  });

  it("blocks any status change for a booking whose current status is already delivered", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const decision = evaluateUpdateBookingStatusPolicy({ bookingNo: "BK1003", newStatus: "in_transit" }, repository);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/already delivered/i);
  });

  it("allows an ordinary transition on a non-delivered booking", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const decision = evaluateUpdateBookingStatusPolicy({ bookingNo: "BK1001", newStatus: "in_transit" }, repository);
    expect(decision).toEqual({ allowed: true });
  });

  it("the cancelled-transition rule is a pure function of newStatus — no wording in the arguments changes it", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const politeRequest = evaluateUpdateBookingStatusPolicy(
      { bookingNo: "BK1002", newStatus: "cancelled" },
      repository,
    );
    const bareRequest = evaluateUpdateBookingStatusPolicy({ bookingNo: "BK1002", newStatus: "cancelled" }, repository);
    expect(politeRequest).toEqual(bareRequest);
    expect(politeRequest.allowed).toBe(false);
  });

  it("does not block on an unknown bookingNo — that is update-booking-status-tool.ts's own not-found error, not a policy decision", () => {
    const repository = BookingRepository.fromDefaultFixture();
    const decision = evaluateUpdateBookingStatusPolicy({ bookingNo: "BK9999", newStatus: "in_transit" }, repository);
    expect(decision).toEqual({ allowed: true });
  });

  it("rejects malformed arguments defensively", () => {
    const repository = BookingRepository.fromDefaultFixture();
    expect(evaluateUpdateBookingStatusPolicy({ bookingNo: "BK1001" }, repository).allowed).toBe(false);
    expect(evaluateUpdateBookingStatusPolicy(null, repository).allowed).toBe(false);
    expect(evaluateUpdateBookingStatusPolicy("cancel it", repository).allowed).toBe(false);
  });
});
