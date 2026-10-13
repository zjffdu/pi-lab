import { ConnectorFailure, BudgetExhaustedError, RETRYABLE_CATEGORIES, type AttemptBudget, type FailureCategory } from "./errors.js";
import type { Deadline } from "./deadline.js";
import { parseBookingResponse, parseContainersResponse, type BookingRecord, type ContainerPage, type ContainerRecord } from "./schemas.js";
import type { AttemptTrace } from "./trace.js";
import { assertSecurityContext, type SecurityContext } from "../security-context.js";

export interface RetryConfig {
  /** Attempts per logical request, the first included. 1 means "never retry". */
  maxAttemptsPerRequest: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Cap on one HTTP attempt; the remaining tool/run deadline caps it further. */
  attemptTimeoutMs: number;
  /** Total time one logical request may spend waiting between its attempts. */
  maxTotalWaitMs: number;
  /** A `Retry-After` longer than this is not honored: the request fails fast and reports the wait. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttemptsPerRequest: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  attemptTimeoutMs: 3_000,
  maxTotalWaitMs: 5_000,
  maxRetryAfterMs: 5_000,
};

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or as soon as `signal` aborts. The caller re-checks the signal. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export interface ConnectorConfig {
  baseUrl: string;
  /** The service credential. It stays inside the connector: no tool, argument, or model message carries it. */
  credential: () => string;
  pageSize: number;
  /** Ceiling on pages fetched for one lookup, independent of the run's page budget. */
  maxPagesPerLookup: number;
  maxResponseBytes: number;
  retry: RetryConfig;
  /** The business clock: what "now" means for freshness and future-timestamp checks. */
  clock: () => Date;
  sleep?: Sleep;
  fetchImpl?: typeof fetch;
}

/** Everything one connector call needs from the request and the run — passed explicitly, never ambient. */
export interface CallScope {
  /** Aborts when the caller stops caring: the run was aborted or the client disconnected. */
  cancel: AbortSignal;
  deadline: Deadline;
  budget: AttemptBudget;
  trace: AttemptTrace;
  requestId: string;
  toolCallId: string;
}

export type BookingLookup = { found: false } | { found: true; booking: BookingRecord; asOf: string };

export type IncompleteReason =
  | { kind: "failure"; category: FailureCategory; atPage: number; retryAfterMs?: number }
  | { kind: "budget"; dimension: string; atPage: number }
  | { kind: "page_limit"; limit: number }
  /** The listing ended, but its containers are not the booking's own: some are missing, some are not theirs. */
  | { kind: "identity_mismatch"; expected: number; received: number; missing: string[]; unexpected: string[] };

export interface ContainerListing {
  items: ContainerRecord[];
  pagesFetched: number;
  complete: boolean;
  incomplete?: IncompleteReason;
}

/** The stable interface the rest of the application depends on; the HTTP client below is one implementation. */
export interface BookingConnector {
  getBooking(scope: CallScope, context: SecurityContext, bookingNo: string): Promise<BookingLookup>;
  listContainers(scope: CallScope, context: SecurityContext, bookingNo: string, expectedContainerNos: readonly string[]): Promise<ContainerListing>;
}

export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

/**
 * The HTTP booking connector — and the **only** place that retries a booking-API request.
 *
 * Retry ownership across the stack (see README):
 * - `fetch` itself never retries.
 * - This class retries transient failures, bounded by `RetryConfig`, the tool/run deadline, and the
 *   run's connector-attempt budget (so the model calling the tool again cannot multiply attempts).
 * - Pi's harness retry and the provider SDK's retry govern *model* calls, a different dependency;
 *   `createHarness` sets both explicitly so they do not stack.
 */
export class HttpBookingConnector implements BookingConnector {
  private readonly sleep: Sleep;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly config: ConnectorConfig) {
    this.sleep = config.sleep ?? realSleep;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  public async getBooking(scope: CallScope, context: SecurityContext, bookingNo: string): Promise<BookingLookup> {
    assertSecurityContext(context);
    const path = `/v1/tenants/${encodeURIComponent(context.tenantId)}/bookings/${encodeURIComponent(bookingNo)}`;
    const result = await this.request(scope, { route: "booking", page: 1, path, notFoundIsAnswer: true }, (body) => parseBookingResponse(body, bookingNo, this.config.clock()));
    return result === "not_found" ? { found: false } : { found: true, ...result };
  }

  /**
   * Follows `nextCursor` until the listing ends. A failure after the listing has started does not
   * discard what was retrieved: the caller gets the items so far with `complete: false` and the
   * reason, and decides how to present it. Only cancellation propagates as an exception — once the
   * caller has gone away there is nobody to report a partial result to.
   */
  public async listContainers(scope: CallScope, context: SecurityContext, bookingNo: string, expectedContainerNos: readonly string[]): Promise<ContainerListing> {
    assertSecurityContext(context);
    const items: ContainerRecord[] = [];
    const seenCursors = new Set<string>();
    const seenContainers = new Set<string>();
    const expectedSet = new Set(expectedContainerNos);
    // A container that is not the booking's must contribute nothing — to the list shown or to the weight — on EVERY way out, not only a mismatch.
    const own = (): ContainerRecord[] => items.filter((item) => expectedSet.has(item.containerNo));
    let cursor: string | null = null;
    let pagesFetched = 0;

    while (true) {
      const atPage = pagesFetched + 1;
      if (atPage > this.config.maxPagesPerLookup) return { items: own(), pagesFetched, complete: false, incomplete: { kind: "page_limit", limit: this.config.maxPagesPerLookup } };
      try {
        scope.budget.reservePage();
      } catch (error) {
        if (error instanceof BudgetExhaustedError) return { items: own(), pagesFetched, complete: false, incomplete: { kind: "budget", dimension: error.dimension, atPage } };
        throw error;
      }

      const query = new URLSearchParams({ limit: String(this.config.pageSize) });
      if (cursor !== null) query.set("cursor", cursor);
      const path = `/v1/tenants/${encodeURIComponent(context.tenantId)}/bookings/${encodeURIComponent(bookingNo)}/containers?${query}`;

      let page: ContainerPage;
      try {
        const result = await this.request(scope, { route: "containers", page: atPage, path, notFoundIsAnswer: false }, (body) => parseContainersResponse(body, this.config.clock()));
        if (result === "not_found") throw new ConnectorFailure("bad_request", "container listing not found");
        page = result.page;
      } catch (error) {
        // Nothing was sent (cancelled, out of time, or out of attempts before the first dispatch): the page is not spent.
        if (error instanceof ConnectorFailure && error.info.attempts === 0) scope.budget.releasePage();
        if (!(error instanceof ConnectorFailure) || error.category === "cancelled") throw error;
        return {
          items: own(),
          pagesFetched,
          complete: false,
          incomplete: { kind: "failure", category: error.category, atPage, ...(error.info.retryAfterMs === undefined ? {} : { retryAfterMs: error.info.retryAfterMs }) },
        };
      }

      pagesFetched = atPage;
      // A container already seen on an earlier page would be counted twice, and the count check below could still pass.
      if (page.items.some((item) => seenContainers.has(item.containerNo))) {
        return { items: own(), pagesFetched, complete: false, incomplete: { kind: "failure", category: "pagination_error", atPage } };
      }
      for (const item of page.items) seenContainers.add(item.containerNo);
      items.push(...page.items);
      if (page.nextCursor === null) {
        // Completeness is identity, not a count: a swapped container leaves the count intact.
        const missing = expectedContainerNos.filter((containerNo) => !seenContainers.has(containerNo));
        const unexpected = [...seenContainers].filter((containerNo) => !expectedSet.has(containerNo));
        if (missing.length > 0 || unexpected.length > 0) {
          return { items: own(), pagesFetched, complete: false, incomplete: { kind: "identity_mismatch", expected: expectedContainerNos.length, received: items.length, missing, unexpected } };
        }
        return { items, pagesFetched, complete: true };
      }
      // A cursor we have already followed (or that never advances) would loop until a limit stopped it.
      if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
        return { items: own(), pagesFetched, complete: false, incomplete: { kind: "failure", category: "pagination_error", atPage: atPage + 1 } };
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private backoff(attempt: number): number {
    const { baseDelayMs, maxDelayMs } = this.config.retry;
    return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  }

  /** One logical request: up to `maxAttemptsPerRequest` attempts, every decision bounded before it is taken. */
  private async request<T>(
    scope: CallScope,
    meta: { route: "booking" | "containers"; page: number; path: string; notFoundIsAnswer: boolean },
    parse: (body: unknown) => T,
  ): Promise<T | "not_found"> {
    const { retry } = this.config;
    const opId = `${scope.toolCallId}:${meta.route}:${meta.page}`;
    let waitedMs = 0;
    let waitBeforeMs = 0;

    for (let attempt = 1; ; attempt++) {
      if (scope.cancel.aborted) throw new ConnectorFailure("cancelled", "the request was cancelled", { attempts: attempt - 1 });
      if (scope.deadline.expired()) throw new ConnectorFailure("deadline_exceeded", "the time allowed for this call ran out", { attempts: attempt - 1 });
      try {
        scope.budget.reserveAttempt();
      } catch (error) {
        if (error instanceof BudgetExhaustedError) throw new ConnectorFailure("budget_exhausted", "this run's connector-attempt budget is used up", { attempts: attempt - 1 });
        throw error;
      }

      // The attempt gets the shorter of its own timeout and what is left of the deadline. If the deadline is the
      // shorter one, running out is the deadline's doing, not a slow server's.
      const remaining = scope.deadline.remainingMs();
      const cappedByDeadline = remaining <= retry.attemptTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(retry.attemptTimeoutMs, remaining))));
      const signal = AbortSignal.any([scope.cancel, timeoutSignal]);
      const started = performance.now();
      let failure: ConnectorFailure;
      try {
        const outcome = await this.attemptOnce(signal, scope, meta, opId, attempt, parse);
        scope.trace.push({ requestId: scope.requestId, toolCallId: scope.toolCallId, opId, route: meta.route, page: meta.page, attempt, outcome: outcome === "not_found" ? "not_found" : "ok", httpStatus: outcome === "not_found" ? 404 : 200, elapsedMs: Math.round(performance.now() - started), waitBeforeMs });
        return outcome;
      } catch (error) {
        failure = this.classify(error, scope, timeoutSignal, cappedByDeadline).with({ attempts: attempt });
      }
      scope.trace.push({ requestId: scope.requestId, toolCallId: scope.toolCallId, opId, route: meta.route, page: meta.page, attempt, outcome: failure.category, httpStatus: failure.info.httpStatus, elapsedMs: Math.round(performance.now() - started), waitBeforeMs });

      if (!RETRYABLE_CATEGORIES.has(failure.category)) throw failure.with({ stopped: "not_retryable" });
      if (attempt >= retry.maxAttemptsPerRequest) throw failure.with({ stopped: "attempts_exhausted" });

      const requested = failure.info.retryAfterMs;
      if (requested !== undefined && requested > retry.maxRetryAfterMs) throw failure.with({ stopped: "wait_exceeds_budget" });
      const delay = requested ?? this.backoff(attempt);
      if (waitedMs + delay > retry.maxTotalWaitMs) throw failure.with({ stopped: "wait_exceeds_budget" });
      // Waiting only makes sense if there is time left to *use* the next attempt afterwards.
      if (delay >= scope.deadline.remainingMs()) throw failure.with({ stopped: "wait_exceeds_deadline" });

      waitedMs += delay;
      waitBeforeMs = delay;
      await this.sleep(delay, scope.cancel);
    }
  }

  private async attemptOnce<T>(
    signal: AbortSignal,
    scope: CallScope,
    meta: { route: "booking" | "containers"; page: number; path: string; notFoundIsAnswer: boolean },
    opId: string,
    attempt: number,
    parse: (body: unknown) => T,
  ): Promise<T | "not_found"> {
    const response = await this.fetchImpl(`${this.config.baseUrl}${meta.path}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.config.credential()}`,
        "x-request-id": scope.requestId,
        "x-tool-call-id": scope.toolCallId,
        "x-op-id": opId,
        "x-attempt": String(attempt),
      },
    });

    const status = response.status;
    if (status === 404 && meta.notFoundIsAnswer) {
      await response.body?.cancel();
      return "not_found";
    }
    if (status !== 200) {
      await response.body?.cancel();
      const retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(response.headers.get("retry-after"), this.config.clock()) : undefined;
      throw new ConnectorFailure(this.categoryForStatus(status), `the booking service answered HTTP ${status}`, {
        attempts: attempt,
        httpStatus: status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }

    const tooLarge = () => new ConnectorFailure("malformed_response", "response larger than the size limit", { attempts: attempt, httpStatus: 200 });
    if (Number(response.headers.get("content-length") ?? "0") > this.config.maxResponseBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const raw = await this.readBounded(response, tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ConnectorFailure("malformed_response", "response body is not valid JSON", { attempts: attempt, httpStatus: 200 });
    }
    return parse(body);
  }

  /** Reads at most `maxResponseBytes`, counting as it goes: a chunked body with no Content-Length is cut off, not buffered whole. */
  private async readBounded(response: Response, tooLarge: () => ConnectorFailure): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.config.maxResponseBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private categoryForStatus(status: number): FailureCategory {
    if (status === 401) return "unauthenticated";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate_limited";
    if (status === 408) return "timeout";
    if (status >= 500) return "unavailable";
    return "bad_request";
  }

  /** Who stopped the attempt decides the category. Cancellation outranks the deadline, which outranks the attempt timeout. */
  private classify(error: unknown, scope: CallScope, timeoutSignal: AbortSignal, cappedByDeadline: boolean): ConnectorFailure {
    // A failure the dependency already determined (a 403, a defective body) is reported as it was, even if the caller left meanwhile.
    if (error instanceof ConnectorFailure) return error;
    if (scope.cancel.aborted) return new ConnectorFailure("cancelled", "the request was cancelled");
    if (scope.deadline.expired() || (timeoutSignal.aborted && cappedByDeadline)) return new ConnectorFailure("deadline_exceeded", "the time allowed for this call ran out");
    if (timeoutSignal.aborted) return new ConnectorFailure("timeout", "the booking service did not answer in time");
    return new ConnectorFailure("network_error", "the booking service could not be reached");
  }
}
