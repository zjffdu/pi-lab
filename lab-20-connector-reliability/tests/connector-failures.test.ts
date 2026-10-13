import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNLIMITED_BUDGET } from "../src/connector/errors.js";
import { AttemptTrace } from "../src/connector/trace.js";
import { RunBudget, DEFAULT_LIMITS } from "../src/run-budget.js";
import { TENANT_A_ONLY_TOKEN } from "../src/fake-api/server.js";
import { HttpBookingConnector } from "../src/connector/http-connector.js";
import { BK1001_CONTAINERS, contextFor, eventually, FAST_RETRY, NOW, scopeFor, sleepMs, startConnector, type ConnectorRig } from "./helpers.js";

let rig: ConnectorRig;
beforeEach(async () => {
  rig = await startConnector();
});
afterEach(async () => {
  await rig.close();
});

const book = (scope = scopeFor(), tenant = "tenant-a", subject = "alice") => rig.connector.getBooking(scope, contextFor(tenant, subject), "BK1001");

describe("authorization failures are never retried", () => {
  it("401: an unknown credential is refused once", async () => {
    await rig.close();
    rig = await startConnector({ credential: "not-a-real-token" });
    await expect(book()).rejects.toMatchObject({ category: "unauthenticated", info: { attempts: 1, httpStatus: 401, stopped: "not_retryable" } });
    expect(rig.api.log).toHaveLength(1);
    expect(rig.sleeps).toEqual([]);
  });

  it("403: a credential scoped to another tenant is refused once", async () => {
    await rig.close();
    rig = await startConnector({ credential: TENANT_A_ONLY_TOKEN });
    await expect(book(scopeFor(), "tenant-b", "erin")).rejects.toMatchObject({ category: "forbidden", info: { attempts: 1, httpStatus: 403, stopped: "not_retryable" } });
    expect(rig.api.log).toHaveLength(1);
    expect(rig.sleeps).toEqual([]);
  });

  it("403 and 429 do not behave alike: the same request is retried after 429 but not after 403", async () => {
    rig.api.inject({ kind: "status", status: 429, retryAfter: "1" }, { route: "booking" });
    expect((await book()).found).toBe(true);
    expect(rig.api.log).toHaveLength(2);

    await rig.close();
    rig = await startConnector({ credential: TENANT_A_ONLY_TOKEN });
    await expect(book(scopeFor(), "tenant-b", "erin")).rejects.toMatchObject({ category: "forbidden" });
    expect(rig.api.log).toHaveLength(1);
  });
});

describe("bounded retries", () => {
  it("429 with Retry-After waits exactly that long, once, then succeeds", async () => {
    rig.api.inject({ kind: "status", status: 429, retryAfter: "2" }, { route: "booking" });
    const trace = new AttemptTrace();
    expect((await book(scopeFor({ trace }))).found).toBe(true);
    expect(rig.sleeps).toEqual([2000]);
    expect(trace.records.map((record) => [record.attempt, record.outcome, record.waitBeforeMs])).toEqual([
      [1, "rate_limited", 0],
      [2, "ok", 2000],
    ]);
  });

  it("on a retry path, the trace and the API's own log agree attempt for attempt", async () => {
    rig.api.inject({ kind: "status", status: 429, retryAfter: "1" }, { route: "booking" });
    rig.api.inject({ kind: "status", status: 503 }, { route: "containers", page: 1 });
    const trace = new AttemptTrace();
    await rig.connector.listContainers(scopeFor({ trace }), contextFor(), "BK1001", BK1001_CONTAINERS); // page requests only
    await book(scopeFor({ trace, toolCallId: "tool-2" }));
    const byOp = (records: Array<{ opId?: string | undefined; attempt?: number | undefined }>) => records.map((r) => `${r.opId}#${r.attempt}`);
    expect(byOp(rig.api.log)).toEqual(byOp(trace.records));
    expect(trace.records.map((r) => r.outcome)).toEqual(expect.arrayContaining(["unavailable", "rate_limited", "ok"]));
  });

  it("Retry-After may be an HTTP date", async () => {
    rig.api.inject({ kind: "status", status: 429, retryAfter: new Date(Date.parse("2026-09-20T00:00:03Z")).toUTCString() }, { route: "booking" });
    await book();
    expect(rig.sleeps).toEqual([3000]);
  });

  it("a Retry-After longer than the allowed wait fails fast and reports what the server asked for", async () => {
    rig.api.inject({ kind: "status", status: 429, retryAfter: "30" }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ category: "rate_limited", info: { attempts: 1, retryAfterMs: 30_000, stopped: "wait_exceeds_budget" } });
    expect(rig.api.log).toHaveLength(1);
    expect(rig.sleeps).toEqual([]);
  });

  it("the Retry-After cap is its own limit: a wait that would fit the total budget is still refused when the server asks for more than the cap", async () => {
    await rig.close();
    rig = await startConnector({ retry: { maxRetryAfterMs: 5_000, maxTotalWaitMs: 60_000 } });
    rig.api.inject({ kind: "status", status: 429, retryAfter: "8" }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ category: "rate_limited", info: { retryAfterMs: 8_000, stopped: "wait_exceeds_budget" } });
    expect(rig.sleeps).toEqual([]);
    expect(rig.api.log).toHaveLength(1);
  });

  it("503 is retried with exponential backoff, then succeeds", async () => {
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, 2);
    expect((await book()).found).toBe(true);
    expect(rig.sleeps).toEqual([10, 20]);
    expect(rig.api.log).toHaveLength(3);
  });

  it("a persistent 503 stops at the attempt limit, and the waiting stays inside the wait budget", async () => {
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ category: "unavailable", info: { attempts: 3, stopped: "attempts_exhausted" } });
    expect(rig.api.log).toHaveLength(3);
    expect(rig.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(FAST_RETRY.maxTotalWaitMs);
  });

  it("the total wait budget stops retrying before the attempt limit does", async () => {
    await rig.close();
    rig = await startConnector({ retry: { maxAttemptsPerRequest: 10, maxTotalWaitMs: 15 } });
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ category: "unavailable", info: { stopped: "wait_exceeds_budget" } });
    expect(rig.sleeps).toEqual([10]); // 10 fits in 15; the next wait (20) would make 30
    expect(rig.api.log).toHaveLength(2);
  });

  it("a wait that would outlast the deadline is not taken", async () => {
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    await expect(book(scopeFor({ deadlineMs: 5 }))).rejects.toMatchObject({ info: { stopped: "wait_exceeds_deadline" } });
    expect(rig.sleeps).toEqual([]);
  });

  it("maxAttemptsPerRequest = 1 means never retry", async () => {
    await rig.close();
    rig = await startConnector({ retry: { maxAttemptsPerRequest: 1 } });
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ info: { attempts: 1, stopped: "attempts_exhausted" } });
    expect(rig.api.log).toHaveLength(1);
  });
});

describe("deadlines and hung requests", () => {
  it("a hung attempt times out and is retried; a later attempt can succeed", async () => {
    await rig.close();
    rig = await startConnector({ retry: { attemptTimeoutMs: 80 } });
    rig.api.inject({ kind: "hang" }, { route: "booking" });
    const trace = new AttemptTrace();
    expect((await book(scopeFor({ trace }))).found).toBe(true);
    expect(trace.records.map((record) => record.outcome)).toEqual(["timeout", "ok"]);
    await eventually(() => rig.api.log[0]?.clientAborted === true); // the connector hung up on the stuck request
  });

  it("a hang on every attempt ends in a timeout after the attempt limit", async () => {
    await rig.close();
    rig = await startConnector({ retry: { attemptTimeoutMs: 60 } });
    rig.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    await expect(book()).rejects.toMatchObject({ category: "timeout", info: { attempts: 3, stopped: "attempts_exhausted" } });
    expect(rig.api.log).toHaveLength(3);
  });

  it("an attempt cut short by the deadline is deadline_exceeded even if the clock has not quite reached it (timers can fire early)", async () => {
    // A deadline that always claims time remains, so only the "attempt was capped by the deadline" rule can classify this.
    const stubDeadline = { remainingMs: () => 40, expired: () => false, child: () => stubDeadline } as unknown as ReturnType<typeof scopeFor>["deadline"];
    await rig.close();
    rig = await startConnector({ retry: { attemptTimeoutMs: 10_000, baseDelayMs: 500, maxDelayMs: 500 } });
    rig.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    const scope = { ...scopeFor(), deadline: stubDeadline };
    await expect(book(scope)).rejects.toMatchObject({ category: "deadline_exceeded" });
  });

  it("the overall deadline caps a hang even when the attempt timeout is long, and reaches the dependency", async () => {
    await rig.close();
    rig = await startConnector({ retry: { attemptTimeoutMs: 10_000 } });
    rig.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    const started = performance.now();
    await expect(book(scopeFor({ deadlineMs: 120 }))).rejects.toMatchObject({ category: "deadline_exceeded" });
    expect(performance.now() - started).toBeLessThan(1_000);
    await eventually(() => rig.api.log[0]?.clientAborted === true);
    expect(rig.api.log).toHaveLength(1);
  });
});

describe("cancellation — what it reaches, and what it cannot undo", () => {
  it("cancelling while a request is in flight aborts it at the API and is not retried", async () => {
    rig.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    const controller = new AbortController();
    const pending = book(scopeFor({ cancel: controller.signal }));
    await eventually(() => rig.api.log.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    await eventually(() => rig.api.log[0]?.clientAborted === true);
    expect(rig.api.log).toHaveLength(1);
  });

  it("cancelling during a backoff wait stops the retry: no further request is sent", async () => {
    await rig.close();
    rig = await startConnector({ realSleep: true, retry: { baseDelayMs: 800, maxDelayMs: 800 } });
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    const controller = new AbortController();
    const pending = book(scopeFor({ cancel: controller.signal }));
    await eventually(() => rig.api.log.length === 1);
    const abortedAt = performance.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    expect(performance.now() - abortedAt).toBeLessThan(300); // the wait was interrupted, not sat out (it is 800 ms)
    await sleepMs(900);
    expect(rig.api.log).toHaveLength(1);
  });

  it("an already-cancelled scope sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(book(scopeFor({ cancel: controller.signal }))).rejects.toMatchObject({ category: "cancelled", info: { attempts: 0 } });
    expect(rig.api.log).toEqual([]);
  });

  it("cancellation does not undo work the server already started: the request was abandoned, the work still finished", async () => {
    rig.api.inject({ kind: "delay", ms: 200 }, { route: "booking" });
    const controller = new AbortController();
    const pending = book(scopeFor({ cancel: controller.signal }));
    await eventually(() => rig.api.log.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    expect(rig.api.workCompleted).toBe(0);
    await eventually(() => rig.api.workCompleted === 1);
    expect(rig.api.log[0]).toMatchObject({ clientAborted: true, workCompleted: true });
  });
});

describe("the run's attempt budget", () => {
  const budgetOf = (maxConnectorAttempts: number, maxPages = 100) => new RunBudget({ ...DEFAULT_LIMITS, maxConnectorAttempts, maxPages });

  it("caps attempts below the per-request limit; nothing is dispatched once it is spent", async () => {
    rig.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    const budget = budgetOf(2);
    await expect(book(scopeFor({ budget }))).rejects.toMatchObject({ category: "budget_exhausted", info: { attempts: 2 } });
    expect(rig.api.log).toHaveLength(2);
    expect(budget.usage.connectorAttempts).toBe(2);

    // The budget is per run: a second logical request in the same run gets nothing.
    await expect(book(scopeFor({ budget }))).rejects.toMatchObject({ category: "budget_exhausted", info: { attempts: 0 } });
    expect(rig.api.log).toHaveLength(2);
  });

  it("does not cancel or refund a call already in flight: spending the last attempt still lets it finish", async () => {
    rig.api.inject({ kind: "delay", ms: 100 }, { route: "booking" });
    const budget = budgetOf(1);
    expect((await book(scopeFor({ budget }))).found).toBe(true);
    expect(budget.isExhausted("connector_attempts")).toBe(false); // reserved 1 of 1; exhaustion is only noticed on the *next* reservation
    expect(() => budget.reserveAttempt()).toThrow(/connector_attempts/);
  });

  it("a page whose request was never sent is not charged to the page budget", async () => {
    const budget = budgetOf(2); // booking + page 1 use both attempts; page 2 is refused before any dispatch
    const scope = scopeFor({ budget });
    const listing = await rig.connector.listContainers(scope, contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing.pagesFetched).toBe(2);
    expect(budget.usage.pages).toBe(listing.pagesFetched);
    expect(rig.api.requestsFor("containers")).toHaveLength(2);
  });

  it("stops a listing at the page budget and reports the reason", async () => {
    const budget = budgetOf(100, 2);
    const listing = await rig.connector.listContainers(scopeFor({ budget }), contextFor(), "BK1001", BK1001_CONTAINERS);
    expect(listing).toMatchObject({ complete: false, pagesFetched: 2, incomplete: { kind: "budget", dimension: "pages", atPage: 3 } });
    expect(rig.api.requestsFor("containers")).toHaveLength(2);
  });

  it("an unlimited budget is what standalone use passes", () => {
    expect(() => UNLIMITED_BUDGET.reserveAttempt()).not.toThrow();
  });
});

describe("a determined failure is not relabeled by a concurrent cancel", () => {
  it("a 403 that arrives as the caller leaves is still reported as forbidden", async () => {
    const controller = new AbortController();
    const connector = new HttpBookingConnector({
      baseUrl: "http://unused.invalid",
      credential: () => "x",
      pageSize: 2,
      maxPagesPerLookup: 5,
      maxResponseBytes: 1_024,
      retry: FAST_RETRY,
      clock: () => NOW,
      // The caller leaves at the very moment the dependency refuses.
      fetchImpl: async () => {
        controller.abort();
        return new Response("{}", { status: 403 });
      },
    });
    await expect(connector.getBooking(scopeFor({ cancel: controller.signal }), contextFor(), "BK1001")).rejects.toMatchObject({ category: "forbidden", info: { httpStatus: 403 } });
  });
});
