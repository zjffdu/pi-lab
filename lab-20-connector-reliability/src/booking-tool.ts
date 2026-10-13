import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import { ConnectorFailure, type FailureCategory, type RetryStop } from "./connector/errors.js";
import type { IncompleteReason } from "./connector/http-connector.js";
import type { BookingLookupService, LookupOutcome } from "./connector/lookup.js";
import type { CallScope } from "./connector/http-connector.js";
import type { RunBudget } from "./run-budget.js";
import type { AttemptTrace } from "./connector/trace.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

const parameters = Type.Object(
  { bookingNo: Type.String({ description: "Booking number, for example BK1001", pattern: "^[A-Za-z0-9-]{3,20}$" }) },
  { additionalProperties: false },
);

/** The structured account of one lookup: kept in the session (`details`) and returned in the run result. */
export interface LookupDetails {
  toolCallId: string;
  bookingNo: string;
  outcome: "complete" | "partial" | "not_found" | "failed";
  stale: boolean;
  containersExpected?: number;
  containersRetrieved?: number;
  totalWeightKg?: number | null;
  incomplete?: IncompleteReason;
  failure?: { category: FailureCategory; attempts: number; httpStatus?: number; retryAfterMs?: number; stopped?: RetryStop };
}

export interface BookingToolOptions {
  context: SecurityContext;
  lookup: BookingLookupService;
  budget: RunBudget;
  trace: AttemptTrace;
  onLookup: (details: LookupDetails) => void;
}

function describeIncomplete(reason: IncompleteReason): string {
  switch (reason.kind) {
    case "failure":
      return `the booking service failed (${reason.category}) while fetching page ${reason.atPage}${reason.retryAfterMs === undefined ? "" : `; it asked for a ${Math.ceil(reason.retryAfterMs / 1000)} s wait`}`;
    case "budget":
      return `this request's ${reason.dimension.replace("_", " ")} budget was used up before page ${reason.atPage}`;
    case "page_limit":
      return `the listing was longer than the ${reason.limit}-page limit`;
    case "identity_mismatch": {
      const names = (label: string, list: string[]) => (list.length === 0 ? "" : `; ${label}: ${list.slice(0, 5).join(", ")}${list.length > 5 ? `, +${list.length - 5} more` : ""}`);
      return `the listing's containers are not the booking's own (the record names ${reason.expected}, the listing returned ${reason.received}${names("missing", reason.missing)}${names("not on the booking", reason.unexpected)})`;
    }
  }
}

/**
 * The model-visible account of a lookup. Numbers and date conclusions are the ones the application
 * computed over validated data; an incomplete listing carries no total at all, only a labeled lower
 * bound, and says so in words. `maxChars` bounds the container list; the header is always complete.
 */
export function renderLookup(outcome: LookupOutcome, maxChars: number): string {
  if (outcome.kind === "not_found") {
    return `NO_RESULT: no booking ${outcome.bookingNo} exists for your organization. This does not say why; report it as not found and do not guess.`;
  }
  const { containers } = outcome;
  const stale =
    outcome.freshness === "stale"
      ? `STALE (record last updated ${outcome.updatedAt}, ${outcome.ageDays} days before ${outcome.computedAt}; it may be out of date — say so)`
      : "fresh";
  const header = [
    `${containers.complete ? "LOOKUP_COMPLETE" : "LOOKUP_PARTIAL"} booking=${outcome.bookingNo}`,
    `status=${outcome.status}`,
    `document_cutoff=${outcome.documentCutoff} cutoff_passed=${outcome.cutoffPassed} (application-computed at ${outcome.computedAt})`,
    `record_updated_at=${outcome.updatedAt} freshness=${stale}`,
  ];
  if (containers.complete) {
    header.push(
      `containers: count=${containers.expected} pages=${containers.pagesFetched} total_weight_kg=${containers.totalWeightKg} (application-computed over all ${containers.expected} validated containers; quote it, do not recompute)`,
    );
  } else {
    header.push(
      `containers: expected=${containers.expected} retrieved=${containers.retrieved.length} pages=${containers.pagesFetched} total_weight_kg=UNKNOWN retrieved_weight_kg=${containers.retrievedWeightKg} (a lower bound over ${containers.retrieved.length} of ${containers.expected} containers, NOT a total)`,
      `incomplete_because: ${containers.incomplete ? describeIncomplete(containers.incomplete) : "unknown"}`,
      "Do not present a total or a count for this booking as complete. Say the data is incomplete and why.",
    );
  }

  const lines = containers.retrieved.map((item) => `- ${item.containerNo} ${item.weightKg} kg`);
  const kept: string[] = [];
  let used = header.join("\n").length;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  const body = kept.length > 0 ? ["container list:", ...kept] : [];
  if (dropped > 0) body.push(`TRUNCATED: ${dropped} more container(s) not shown to keep this result within its size limit; the figures above still cover every retrieved container.`);
  return [...header, ...body].join("\n");
}

const FAILURE_TEXT: Record<FailureCategory, string> = {
  unauthenticated: "The booking service did not accept the application's credential. Retrying would repeat the refusal.",
  forbidden: "The booking service refused access for this organization. Retrying would repeat the refusal.",
  rate_limited: "The booking service is rate limiting requests and the wait it asked for did not fit this request's limits.",
  unavailable: "The booking service was unavailable.",
  timeout: "The booking service did not answer in time.",
  network_error: "The booking service could not be reached.",
  malformed_response: "The booking service returned data that failed validation, so none of it was used.",
  pagination_error: "The booking service's paging was inconsistent, so the listing could not be read.",
  bad_request: "The booking service rejected the request.",
  deadline_exceeded: "The time allowed for this lookup ran out.",
  cancelled: "The request was cancelled.",
  budget_exhausted: "This request's connector-attempt budget is used up; no further calls will be made.",
};

export function renderFailure(failure: ConnectorFailure, bookingNo: string): string {
  const { attempts, retryAfterMs, stopped } = failure.info;
  const wait = retryAfterMs === undefined ? "" : ` retry_after_seconds=${Math.ceil(retryAfterMs / 1000)}`;
  return [
    `LOOKUP_FAILED booking=${bookingNo} category=${failure.category} attempts=${attempts}${wait}${stopped === undefined ? "" : ` stopped=${stopped}`}`,
    FAILURE_TEXT[failure.category],
    "Retries already happened inside the connector, within their limits. Do not call lookup_booking again for this booking in this request; tell the user the data could not be retrieved and why. The user may try again later.",
  ].join("\n");
}

export function detailsFromOutcome(toolCallId: string, outcome: LookupOutcome): LookupDetails {
  if (outcome.kind === "not_found") return { toolCallId, bookingNo: outcome.bookingNo, outcome: "not_found", stale: false };
  const { containers } = outcome;
  return {
    toolCallId,
    bookingNo: outcome.bookingNo,
    outcome: containers.complete ? "complete" : "partial",
    stale: outcome.freshness === "stale",
    containersExpected: containers.expected,
    containersRetrieved: containers.retrieved.length,
    totalWeightKg: containers.totalWeightKg,
    ...(containers.incomplete === undefined ? {} : { incomplete: containers.incomplete }),
  };
}

export const LOOKUP_TOOL_NAME = "lookup_booking";

/** Stored `details` must be JSON; this drops `undefined` fields the interface allows. */
const asJson = (details: LookupDetails): JsonValue => JSON.parse(JSON.stringify(details)) as JsonValue;

/**
 * Read-only booking lookup through the connector. The caller's tenant comes from the closed-over
 * `SecurityContext`; the tool has no tenant, credential, or URL parameter. Cancellation arrives on the
 * `Context` Pi passes to `execute()` when the run is aborted (`root.abort()`); that signal also fires
 * *after* `execute()` returns, as cleanup, so it is only ever read while the call is running. Declared
 * `replay: "safe"`: a rerun after a crash reads the same booking and changes nothing.
 */
export function createLookupBookingTool(options: BookingToolOptions) {
  assertSecurityContext(options.context);
  const { context, budget } = options;
  return defineTool({
    name: LOOKUP_TOOL_NAME,
    description: "Look up one booking by number in your organization's booking service: status, document cutoff, freshness, and the booking's container numbers with their weights. A booking can have several containers. Reports missing, stale, and incomplete data explicitly.",
    parameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(params, api, runtime) {
      const toolCallId = api.callId;
      const scope: CallScope = {
        cancel: runtime.abortSignal ?? new AbortController().signal,
        deadline: budget.deadline.child(budget.limits.toolTimeoutMs),
        budget,
        trace: options.trace,
        requestId: context.requestId,
        toolCallId,
      };
      try {
        const outcome = await options.lookup.lookup(scope, context, params.bookingNo);
        const details = detailsFromOutcome(toolCallId, outcome);
        options.onLookup(details);
        return { content: [{ type: "text", text: renderLookup(outcome, budget.limits.maxToolResultChars) }], details: asJson(details) };
      } catch (error) {
        if (!(error instanceof ConnectorFailure)) throw error;
        options.onLookup({
          toolCallId,
          bookingNo: params.bookingNo,
          outcome: "failed",
          stale: false,
          failure: {
            category: error.category,
            attempts: error.info.attempts,
            ...(error.info.httpStatus === undefined ? {} : { httpStatus: error.info.httpStatus }),
            ...(error.info.retryAfterMs === undefined ? {} : { retryAfterMs: error.info.retryAfterMs }),
            ...(error.info.stopped === undefined ? {} : { stopped: error.info.stopped }),
          },
        });
        throw new Error(renderFailure(error, params.bookingNo));
      }
    },
  });
}
