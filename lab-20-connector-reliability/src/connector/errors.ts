/**
 * Every way a connector call can end without a usable answer, as one closed set. A category is a
 * statement about *what to do next*, not about the wire: it decides retry, what the model is told,
 * and how the run reports the outcome.
 *
 * - `unauthenticated` / `forbidden`: the dependency refused us. Repeating the request repeats the
 *   refusal, so neither is ever retried (401 vs 403: which credential, not whether to try again).
 * - `rate_limited`: retryable, but only after the server's `Retry-After` and only if that fits the
 *   remaining budget — otherwise it is reported with the wait the server asked for.
 * - `unavailable` / `timeout` / `network_error`: transient; retried within the attempt, wait, and
 *   deadline limits.
 * - `malformed_response` / `pagination_error` / `bad_request`: the dependency answered, and the
 *   answer cannot be used. Retrying returns the same defect, so they are not retried.
 * - `deadline_exceeded` / `cancelled` / `budget_exhausted`: *we* stopped. None is retried.
 */
export const FAILURE_CATEGORIES = [
  "unauthenticated",
  "forbidden",
  "rate_limited",
  "unavailable",
  "timeout",
  "network_error",
  "malformed_response",
  "pagination_error",
  "bad_request",
  "deadline_exceeded",
  "cancelled",
  "budget_exhausted",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const RETRYABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>(["rate_limited", "unavailable", "timeout", "network_error"]);

/** Why the retry loop stopped after a failure. `not_retryable` means the category itself forbids it. */
export type RetryStop = "not_retryable" | "attempts_exhausted" | "wait_exceeds_budget" | "wait_exceeds_deadline";

export interface FailureInfo {
  attempts: number;
  httpStatus?: number;
  /** What the server asked us to wait (`Retry-After`), whether or not we were allowed to. */
  retryAfterMs?: number;
  stopped?: RetryStop;
}

export class ConnectorFailure extends Error {
  public constructor(
    public readonly category: FailureCategory,
    message: string,
    public readonly info: FailureInfo = { attempts: 0 },
  ) {
    super(message);
    this.name = "ConnectorFailure";
  }

  public get retryable(): boolean {
    return RETRYABLE_CATEGORIES.has(this.category);
  }

  public with(info: Partial<FailureInfo>): ConnectorFailure {
    return new ConnectorFailure(this.category, this.message, { ...this.info, ...info });
  }
}

/** Dimensions a run can be limited on. */
export type BudgetDimension = "turns" | "tool_calls" | "pages" | "connector_attempts" | "context" | "output" | "run_deadline";

/** Thrown by a budget reservation. Nothing was dispatched: the reservation happens before the call. */
export class BudgetExhaustedError extends Error {
  public constructor(public readonly dimension: BudgetDimension) {
    super(`budget exhausted: ${dimension}`);
    this.name = "BudgetExhaustedError";
  }
}

/** What the connector needs from a run's budget. Reservations throw `BudgetExhaustedError`. */
export interface AttemptBudget {
  reserveAttempt(): void;
  reservePage(): void;
  /** Gives back a page reserved for a request that was never dispatched. */
  releasePage(): void;
}

export const UNLIMITED_BUDGET: AttemptBudget = { reserveAttempt: () => undefined, reservePage: () => undefined, releasePage: () => undefined };
