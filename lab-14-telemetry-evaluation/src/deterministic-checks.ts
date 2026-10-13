import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";

import type { EvaluationCase } from "./evaluation-cases.js";
import { findByName } from "./span-tree.js";

/**
 * `pass`/`fail` are ordinary verdicts. `skipped` means the check does not apply to this case. `unavailable`
 * means the check could not be evaluated at all because the underlying data does not exist — a deliberately
 * distinct outcome from `fail`, per the roadmap's own instruction: "report it as unavailable rather than
 * zero." A report must never silently fold `unavailable` into `pass` or `fail`.
 */
export type CheckStatus = "pass" | "fail" | "skipped" | "unavailable";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * One raw tool invocation, captured from `tool_execution_start`/`tool_execution_end` — not derived from
 * telemetry spans, which deliberately carry no arguments or result text.
 */
export interface ToolCallRecord {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** Text of the committed tool-result entry; "" when the call faulted and no entry was committed. */
  resultText: string;
}

export interface CaseRunEvidence {
  answerText: string;
  /** `done`, or `unanswered:<reason>` — the terminal state of the submission, never the model's prose. */
  operationStatus: string;
  toolCalls: readonly ToolCallRecord[];
  spans: readonly RecordedTelemetrySpan[];
}

function bookingNoOf(call: ToolCallRecord): string | undefined {
  const value = call.args.bookingNo;
  return typeof value === "string" ? value : undefined;
}

/**
 * Every booking number in `evaluationCase.requiredEvidence` must have at least one successful `get_booking`
 * call for that exact number. This is the roadmap's "required tool evidence" check: a fluent answer that
 * never looked anything up must fail here regardless of how confident its prose sounds.
 */
export function requiredToolEvidence(evaluationCase: EvaluationCase, evidence: CaseRunEvidence): CheckResult {
  if (evaluationCase.requiredEvidence.length === 0) {
    return { name: "required-tool-evidence", status: "skipped", detail: "This case declares no required evidence." };
  }
  const queried = new Set(
    evidence.toolCalls.filter((call) => call.toolName === "get_booking" && !call.isError).map(bookingNoOf),
  );
  const missing = evaluationCase.requiredEvidence.filter((bookingNo) => !queried.has(bookingNo));
  if (missing.length > 0) {
    return {
      name: "required-tool-evidence",
      status: "fail",
      detail: `No successful get_booking call for: ${missing.join(", ")}. Queried: ${[...queried].join(", ") || "none"}.`,
    };
  }
  return { name: "required-tool-evidence", status: "pass", detail: `Evidence present for: ${evaluationCase.requiredEvidence.join(", ")}.` };
}

const BOOKING_NO_PATTERN = /\bBK\d{3,}\b/g;
const CONTAINER_NO_PATTERN = /\b[A-Z]{4}\d{7}\b/g;

function unique(matches: RegExpMatchArray | null): string[] {
  return [...new Set(matches ?? [])];
}

/**
 * Every identifier the answer *names* must be one this run can account for:
 * - a booking number must be one the case allows (`relevantBookingNos`) — a structural proxy for "did the
 *   model invent an identifier it never looked up"; it does not prove claims *about* an allowed booking;
 * - a container number must appear in the text of a successful tool result *of this run*. A container is
 *   never echoed from the prompt, so its only legitimate source is a lookup: a container recalled from
 *   memory, invented, or leaked from another booking has no result to point at and fails.
 */
export function identifierProvenance(evaluationCase: EvaluationCase, evidence: CaseRunEvidence): CheckResult {
  const namedBookings = unique(evidence.answerText.match(BOOKING_NO_PATTERN));
  const allowedBookings = new Set(evaluationCase.relevantBookingNos);
  const inventedBookings = namedBookings.filter((bookingNo) => !allowedBookings.has(bookingNo));

  const namedContainers = unique(evidence.answerText.match(CONTAINER_NO_PATTERN));
  const groundedContainers = new Set(
    evidence.toolCalls.filter((call) => !call.isError).flatMap((call) => call.resultText.match(CONTAINER_NO_PATTERN) ?? []),
  );
  const ungroundedContainers = namedContainers.filter((containerNo) => !groundedContainers.has(containerNo));

  if (inventedBookings.length > 0 || ungroundedContainers.length > 0) {
    const problems: string[] = [];
    if (inventedBookings.length > 0) {
      problems.push(`booking number(s) outside this case's scope: ${inventedBookings.join(", ")}`);
    }
    if (ungroundedContainers.length > 0) {
      problems.push(`container number(s) in no tool result of this run: ${ungroundedContainers.join(", ")}`);
    }
    return { name: "identifier-provenance", status: "fail", detail: `Answer names ${problems.join("; ")}.` };
  }
  const named = [...namedBookings, ...namedContainers];
  return {
    name: "identifier-provenance",
    status: "pass",
    detail: named.length > 0 ? `Named only grounded identifiers: ${named.join(", ")}.` : "Answer names no booking or container numbers.",
  };
}

/**
 * For a case that asks for containers, the answer must name every one of `mustNameContainerNos`. This is the
 * multi-container failure: a booking that carries two containers, described by one.
 */
export function containerCoverage(evaluationCase: EvaluationCase, evidence: CaseRunEvidence): CheckResult {
  if (evaluationCase.mustNameContainerNos.length === 0) {
    return { name: "container-coverage", status: "skipped", detail: "This case does not ask for containers." };
  }
  const missing = evaluationCase.mustNameContainerNos.filter((containerNo) => !evidence.answerText.includes(containerNo));
  if (missing.length > 0) {
    return {
      name: "container-coverage",
      status: "fail",
      detail: `Answer omits container(s): ${missing.join(", ")} (expected all of ${evaluationCase.mustNameContainerNos.join(", ")}).`,
    };
  }
  return { name: "container-coverage", status: "pass", detail: `Named every container: ${evaluationCase.mustNameContainerNos.join(", ")}.` };
}

const CAUSAL_CONNECTIVE_PATTERN = /\b(because|due to|owing to|as a result of|caused by|so that)\b/i;

/**
 * A syntactic proxy, not a semantic-entailment judge: it flags causal-connective language, never whether a
 * causal claim is *true*. `data/bookings.json` carries no cause/reason field for any status, so on a case that
 * invites a causal answer, any causal-connective phrase is by construction unsupported by the only evidence
 * this lab's tools can produce.
 */
export function unsupportedCausalClaims(evaluationCase: EvaluationCase, evidence: CaseRunEvidence): CheckResult {
  if (!evaluationCase.watchForUnsupportedCausalClaims) {
    return {
      name: "unsupported-causal-claims",
      status: "skipped",
      detail: "This case does not invite a causal/explanatory answer.",
    };
  }
  const matched = evidence.answerText.match(CAUSAL_CONNECTIVE_PATTERN);
  if (matched) {
    return {
      name: "unsupported-causal-claims",
      status: "fail",
      detail: `Answer uses causal language ("${matched[0]}") the fixture data cannot ground (no cause/reason field exists).`,
    };
  }
  return { name: "unsupported-causal-claims", status: "pass", detail: "No unsupported causal-connective language detected." };
}

/** The submission must reach `done`; `unanswered` (with its reason) is a different, named failure. */
export function terminalOperationStatus(evidence: CaseRunEvidence): CheckResult {
  if (evidence.operationStatus === "done") {
    return { name: "terminal-operation-status", status: "pass", detail: "Submission status: done." };
  }
  return {
    name: "terminal-operation-status",
    status: "fail",
    detail: `Submission did not reach "done" (got "${evidence.operationStatus}").`,
  };
}

/**
 * For a case with `expectedEffects`, exactly one successful `update_booking_status` call per expected effect
 * must exist — zero means the effect never happened, more than one means a duplicate. For a case with none,
 * zero successful calls must exist: any is an unintended side effect.
 */
export function duplicateEffects(evaluationCase: EvaluationCase, evidence: CaseRunEvidence): CheckResult {
  const executed = evidence.toolCalls.filter((call) => call.toolName === "update_booking_status" && !call.isError);

  if (evaluationCase.expectedEffects.length === 0) {
    if (executed.length > 0) {
      return { name: "duplicate-effects", status: "fail", detail: `Expected zero status changes, observed ${executed.length}.` };
    }
    return { name: "duplicate-effects", status: "pass", detail: "No status-changing calls, as expected." };
  }

  const problems: string[] = [];
  for (const effect of evaluationCase.expectedEffects) {
    const matches = executed.filter((call) => bookingNoOf(call) === effect.bookingNo && call.args.newStatus === effect.newStatus);
    if (matches.length === 0) {
      problems.push(`${effect.bookingNo}->${effect.newStatus}: 0 executions (expected exactly 1)`);
    } else if (matches.length > 1) {
      problems.push(`${effect.bookingNo}->${effect.newStatus}: ${matches.length} executions (expected exactly 1, duplicate effect)`);
    }
  }
  if (problems.length > 0) {
    return { name: "duplicate-effects", status: "fail", detail: problems.join("; ") };
  }
  return { name: "duplicate-effects", status: "pass", detail: "Each expected effect executed exactly once." };
}

function numericAttribute(span: RecordedTelemetrySpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Both numbers are read off `lab.ai.request` spans, which the bridge fills from the committed assistant
 * message. Token usage is reported whenever a request span carries it. Latency is the request's own monotonic
 * `durationMs` (Pi 1.1 stores it on the assistant message) — NOT a span duration: `RecordedTelemetrySpan` still
 * has no timestamp field, so a span's own extent is never measured. It is reported `unavailable`, not `0`,
 * unless *every* request span carries one: a partial sum would be a latency nobody measured.
 */
export function tokenUsageAndLatency(evidence: CaseRunEvidence): [token: CheckResult, latency: CheckResult] {
  const requests = findByName(evidence.spans, "lab.ai.request");

  const tokenCounts = requests.map((span) => numericAttribute(span, "lab.ai.usage.total_tokens"));
  const withTokens = tokenCounts.filter((value): value is number => value !== undefined);
  const tokenCheck: CheckResult =
    requests.length === 0
      ? { name: "token-usage", status: "unavailable", detail: "No lab.ai.request span was recorded for this run." }
      : withTokens.length === 0
        ? { name: "token-usage", status: "unavailable", detail: `${requests.length} request span(s) recorded, none carrying lab.ai.usage.total_tokens.` }
        : { name: "token-usage", status: "pass", detail: `Total tokens across ${requests.length} request span(s): ${withTokens.reduce((sum, value) => sum + value, 0)}.` };

  const durations = requests.map((span) => numericAttribute(span, "lab.ai.duration_ms"));
  const withDuration = durations.filter((value): value is number => value !== undefined);
  const latencyCheck: CheckResult =
    requests.length === 0
      ? { name: "latency", status: "unavailable", detail: "No lab.ai.request span was recorded for this run." }
      : withDuration.length === requests.length
        ? {
            name: "latency",
            status: "pass",
            detail: `Provider time across ${requests.length} request(s): ${Math.round(withDuration.reduce((sum, value) => sum + value, 0))}ms (durationMs from the assistant messages, not a span duration).`,
          }
        : {
            name: "latency",
            status: "unavailable",
            detail: `Only ${withDuration.length} of ${requests.length} request(s) carry durationMs (absent for legacy or deferred results); spans themselves have no timestamps.`,
          };

  return [tokenCheck, latencyCheck] as const;
}

/**
 * Observations this lab's bridge can never make from the 1.1 event stream. Always reported `unavailable` —
 * never `fail` — so a report cannot mistake "this lab cannot observe it" for "it never happened".
 */
export const UNOBSERVABLE = [
  { name: "navigation", reason: "conversation.fork() commits a conversation record, not an entry: no event exists to bridge." },
  { name: "recovery", reason: "the 1.1 stream has no recovery flag, and a recovering process emits no tool_execution_start for the interrupted call." },
] as const;

export function spanCoverageChecks(evidence: CaseRunEvidence, expectedKinds: readonly string[]): CheckResult[] {
  const results: CheckResult[] = expectedKinds.map((name) => {
    const count = findByName(evidence.spans, name).length;
    return count > 0
      ? { name: `span:${name}`, status: "pass" as const, detail: `${count} span(s) recorded.` }
      : { name: `span:${name}`, status: "fail" as const, detail: "Expected at least one span; none recorded." };
  });
  for (const { name, reason } of UNOBSERVABLE) {
    results.push({ name: `unobservable:${name}`, status: "unavailable", detail: reason });
  }
  return results;
}

export function runDeterministicChecks(
  evaluationCase: EvaluationCase,
  evidence: CaseRunEvidence,
  expectedSpanKinds: readonly string[],
): CheckResult[] {
  return [
    requiredToolEvidence(evaluationCase, evidence),
    identifierProvenance(evaluationCase, evidence),
    containerCoverage(evaluationCase, evidence),
    unsupportedCausalClaims(evaluationCase, evidence),
    terminalOperationStatus(evidence),
    duplicateEffects(evaluationCase, evidence),
    ...tokenUsageAndLatency(evidence),
    ...spanCoverageChecks(evidence, expectedSpanKinds),
  ];
}
