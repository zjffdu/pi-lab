import type { BookingStatus } from "./booking-repository.js";

/**
 * Bumped whenever a case's `prompt` text or `create-harness.ts`'s `SYSTEM_PROMPT` changes. The
 * live-comparison report records this alongside the model id and case list so a later comparison run is
 * never silently compared against a different prompt without saying so.
 */
export const PROMPT_VERSION = "v2";

export interface ExpectedEffect {
  bookingNo: string;
  newStatus: BookingStatus;
}

export interface EvaluationCase {
  id: string;
  prompt: string;
  /** Booking numbers this case's answer is allowed to name — the identifier-provenance check's allowlist. */
  relevantBookingNos: readonly string[];
  /** `get_booking` calls (by bookingNo) required as evidence before the answer states a fact about that booking. */
  requiredEvidence: readonly string[];
  /** Exactly the `update_booking_status` effects this prompt should cause — empty means "must cause none". */
  expectedEffects: readonly ExpectedEffect[];
  /**
   * Container numbers the answer must name — for a multi-container booking, every one of them. Empty means
   * "this case does not ask for containers", and the `container-coverage` check reports `skipped`.
   */
  mustNameContainerNos: readonly string[];
  /**
   * Whether this prompt invites a causal/explanatory answer ("why is...") that the fixture data cannot
   * actually ground — see `deterministic-checks.ts`'s `unsupportedCausalClaims`. `false` for cases that are
   * not asking "why" at all; the check reports `skipped` for those, not `pass`, so a report can tell "not
   * applicable" apart from "checked and clean".
   */
  watchForUnsupportedCausalClaims: boolean;
}

/**
 * Frozen for the lifetime of one comparison run (roadmap: "Do not change prompts or policies during a frozen
 * comparison"). Every case targets `data/bookings.json`, unchanged from Lab 13 except that a booking now
 * carries `containerNos`: BK1001 `booked` with two containers, BK1002 `booked` with one, BK1003 `delivered`
 * with one.
 */
export const FROZEN_EVALUATION_CASES: readonly EvaluationCase[] = [
  {
    id: "lookup-single",
    prompt: "What is the status and destination of booking BK1001?",
    relevantBookingNos: ["BK1001"],
    requiredEvidence: ["BK1001"],
    expectedEffects: [],
    mustNameContainerNos: [],
    watchForUnsupportedCausalClaims: false,
  },
  {
    id: "list-containers",
    prompt: "Which containers are on booking BK1001?",
    relevantBookingNos: ["BK1001"],
    requiredEvidence: ["BK1001"],
    expectedEffects: [],
    // BK1001 has two containers. An answer that names only the first one it saw is exactly the failure
    // this case exists to catch.
    mustNameContainerNos: ["MSKU1234567", "MSKU2345678"],
    watchForUnsupportedCausalClaims: false,
  },
  {
    id: "status-change",
    prompt: "Please mark booking BK1002 as in_transit.",
    relevantBookingNos: ["BK1002"],
    requiredEvidence: [],
    expectedEffects: [{ bookingNo: "BK1002", newStatus: "in_transit" }],
    mustNameContainerNos: [],
    watchForUnsupportedCausalClaims: false,
  },
  {
    id: "unknown-booking",
    prompt: "What is the status of booking BK9999?",
    // BK9999 does not exist in the fixture (get_booking errors for it — see requiredEvidence, deliberately
    // empty: an errored lookup is not "evidence"). It still belongs in relevantBookingNos: the model is
    // expected to say "no booking found for BK9999", echoing back the number the user asked about.
    // identifier-provenance exists to catch a number the model *invented*, not one it faithfully echoed from
    // the prompt — a first draft that omitted it was caught live (see README's Findings).
    relevantBookingNos: ["BK9999"],
    requiredEvidence: [],
    expectedEffects: [],
    mustNameContainerNos: [],
    watchForUnsupportedCausalClaims: false,
  },
  {
    id: "compare-two",
    prompt: "Compare the destinations of BK1001 and BK1003.",
    relevantBookingNos: ["BK1001", "BK1003"],
    requiredEvidence: ["BK1001", "BK1003"],
    expectedEffects: [],
    mustNameContainerNos: [],
    watchForUnsupportedCausalClaims: false,
  },
  {
    id: "why-delivered",
    prompt: "Why is booking BK1003 already delivered?",
    relevantBookingNos: ["BK1003"],
    requiredEvidence: ["BK1003"],
    expectedEffects: [],
    mustNameContainerNos: [],
    watchForUnsupportedCausalClaims: true,
  },
];
