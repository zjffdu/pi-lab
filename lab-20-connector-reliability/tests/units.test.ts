import { describe, expect, it } from "vitest";

import { OverloadedError, AdmissionQueue } from "../src/admission-queue.js";
import { renderFailure, renderLookup } from "../src/booking-tool.js";
import { completenessOf, applicationNote } from "../src/chat-service.js";
import { Deadline } from "../src/connector/deadline.js";
import { BudgetExhaustedError, ConnectorFailure, FAILURE_CATEGORIES, RETRYABLE_CATEGORIES } from "../src/connector/errors.js";
import { buildLookupOutcome, DEFAULT_FRESHNESS_MS } from "../src/connector/lookup.js";
import { parseRetryAfter } from "../src/connector/http-connector.js";
import { DEFAULT_LIMITS, RunBudget } from "../src/run-budget.js";
import { UsageMeter, pricingFromEnvironment } from "../src/usage-meter.js";
import { NOW, sleepMs } from "./helpers.js";

const booking = { bookingNo: "BK1", status: "booked", documentCutoff: "2026-09-25T12:00:00Z", updatedAt: "2026-09-19T08:00:00Z", containerNos: ["C1", "C2", "C3"] };
const containers = [
  { containerNo: "C1", weightKg: 100 },
  { containerNo: "C2", weightKg: 250.5 },
  { containerNo: "C3", weightKg: 50 },
];

describe("buildLookupOutcome — conclusions computed over validated data", () => {
  it("sums a complete listing and compares the cutoff with the business clock", () => {
    const outcome = buildLookupOutcome(booking, NOW.toISOString(), { items: containers, pagesFetched: 2, complete: true }, NOW);
    if (outcome.kind !== "found") throw new Error("unreachable");
    expect(outcome.containers).toMatchObject({ totalWeightKg: 400.5, retrievedWeightKg: 400.5, complete: true });
    expect(outcome.cutoffPassed).toBe(false);
  });

  it("the cutoff comparison flips exactly at the cutoff instant", () => {
    const at = (iso: string) => buildLookupOutcome(booking, iso, { items: [], pagesFetched: 0, complete: true }, new Date(iso));
    const passedAt = (iso: string) => (at(iso) as { cutoffPassed: boolean }).cutoffPassed;
    expect(passedAt("2026-09-25T11:59:59Z")).toBe(false);
    expect(passedAt("2026-09-25T12:00:00Z")).toBe(true);
  });

  it("an incomplete listing has no total — only a lower bound labeled as such", () => {
    const outcome = buildLookupOutcome(booking, NOW.toISOString(), { items: containers.slice(0, 2), pagesFetched: 1, complete: false, incomplete: { kind: "budget", dimension: "pages", atPage: 2 } }, NOW);
    if (outcome.kind !== "found") throw new Error("unreachable");
    expect(outcome.containers.totalWeightKg).toBeNull();
    expect(outcome.containers.retrievedWeightKg).toBe(350.5);
  });

  it("freshness flips just past the window", () => {
    const withAge = (ms: number) => buildLookupOutcome({ ...booking, updatedAt: new Date(NOW.getTime() - ms).toISOString() }, NOW.toISOString(), { items: [], pagesFetched: 0, complete: true }, NOW);
    expect((withAge(DEFAULT_FRESHNESS_MS) as { freshness: string }).freshness).toBe("fresh");
    expect((withAge(DEFAULT_FRESHNESS_MS + 1_000) as { freshness: string }).freshness).toBe("stale");
  });
});

describe("what the model is shown", () => {
  const complete = buildLookupOutcome(booking, NOW.toISOString(), { items: containers, pagesFetched: 1, complete: true }, NOW);
  const partial = buildLookupOutcome(booking, NOW.toISOString(), { items: containers.slice(0, 2), pagesFetched: 1, complete: false, incomplete: { kind: "failure", category: "unavailable", atPage: 2 } }, NOW);

  it("a complete lookup states the application-computed total", () => {
    const text = renderLookup(complete, 5_000);
    expect(text).toMatch(/^LOOKUP_COMPLETE/);
    expect(text).toContain("total_weight_kg=400.5");
    expect(text).toContain("cutoff_passed=false");
  });

  it("a partial lookup never contains a total, says why, and warns against presenting it as complete", () => {
    const text = renderLookup(partial, 5_000);
    expect(text).toMatch(/^LOOKUP_PARTIAL/);
    expect(text).toContain("total_weight_kg=UNKNOWN");
    expect(text).not.toMatch(/total_weight_kg=\d/);
    expect(text).toContain("retrieved_weight_kg=350.5");
    expect(text).toContain("unavailable");
    expect(text).toMatch(/incomplete/i);
  });

  it("the container list is cut to the size limit with an explicit marker, the figures stay complete", () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({ containerNo: `CONT${index}`, weightKg: 1 }));
    const text = renderLookup(buildLookupOutcome({ ...booking, containerNos: many.map((item) => item.containerNo) }, NOW.toISOString(), { items: many, pagesFetched: 1, complete: true }, NOW), 600);
    expect(text.length).toBeLessThan(900);
    expect(text).toMatch(/TRUNCATED: \d+ more container/);
    expect(text).toContain("total_weight_kg=50");
  });

  it("failure text names the category and tells the model not to loop", () => {
    const text = renderFailure(new ConnectorFailure("forbidden", "x", { attempts: 1, stopped: "not_retryable" }), "BK1");
    expect(text).toContain("category=forbidden");
    expect(text).toMatch(/Do not call lookup_booking again/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe("completeness and the application note come from structured outcomes", () => {
  const lookup = (outcome: "complete" | "partial" | "not_found" | "failed") => ({ toolCallId: "t", bookingNo: "B", outcome, stale: false });
  it("classifies", () => {
    expect(completenessOf([])).toBe("none");
    expect(completenessOf([lookup("complete")])).toBe("complete");
    expect(completenessOf([lookup("not_found")])).toBe("no_result");
    expect(completenessOf([lookup("failed")])).toBe("unavailable");
    expect(completenessOf([lookup("complete"), lookup("failed")])).toBe("partial");
    expect(completenessOf([lookup("partial")])).toBe("partial");
    expect(completenessOf([lookup("complete"), lookup("not_found")])).toBe("complete");
  });

  it("a clean, complete, fresh, in-limit run gets no note", () => {
    expect(applicationNote({ status: "completed", completeness: "complete", stale: false, lookups: [lookup("complete")], refused: [] })).toBeUndefined();
  });

  it("partial data, staleness, refusals, and an unfinished run each add to the note", () => {
    const note = applicationNote({ status: "incomplete", cause: { kind: "budget", dimension: "turns" }, completeness: "partial", stale: true, lookups: [lookup("partial")], refused: ["tool_calls"] });
    expect(note).toContain("[Application note]");
    expect(note).toMatch(/did not finish/);
    expect(note).toMatch(/incomplete or could not be retrieved/);
    expect(note).toMatch(/out of date/);
    expect(note).toMatch(/refused by request limits/);
  });
});

describe("RunBudget", () => {
  const budget = (overrides: Partial<typeof DEFAULT_LIMITS> = {}) => new RunBudget({ ...DEFAULT_LIMITS, ...overrides });

  it("reserves up to the limit, then refuses without spending", () => {
    const b = budget({ maxToolCalls: 2 });
    b.reserveToolCall();
    b.reserveToolCall();
    expect(() => b.reserveToolCall()).toThrow(BudgetExhaustedError);
    expect(b.usage.toolCalls).toBe(2);
    expect(b.isExhausted("tool_calls")).toBe(true);
    expect(b.isExhausted("pages")).toBe(false); // exhaustion is per dimension
  });

  it("exhaustion is sticky", () => {
    const b = budget({ maxPages: 1 });
    b.reservePage();
    expect(() => b.reservePage()).toThrow();
    expect(() => b.reservePage()).toThrow();
    expect(b.usage.pages).toBe(1);
  });

  it("turns are recorded, and the limit is 'reached' when the next turn would exceed it", () => {
    const b = budget({ maxTurns: 2 });
    b.recordTurn();
    expect(b.turnLimitReached()).toBe(false);
    b.recordTurn();
    expect(b.turnLimitReached()).toBe(true);
  });
});

describe("Deadline", () => {
  it("a child never outlives its parent", () => {
    const parent = Deadline.after(50);
    expect(parent.child(10_000).remainingMs()).toBeLessThanOrEqual(50);
  });

  it("expires", async () => {
    const deadline = Deadline.after(30);
    expect(deadline.expired()).toBe(false);
    await sleepMs(60);
    expect(deadline.expired()).toBe(true);
  });
});

describe("AdmissionQueue", () => {
  const hold = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };

  it("runs up to maxConcurrent, queues up to maxQueued, refuses the rest at once", async () => {
    const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: 1_000 });
    const first = hold();
    const order: string[] = [];
    const a = queue.run(async () => (order.push("a"), first.promise));
    const b = queue.run(async () => void order.push("b"));
    expect(queue.stats).toEqual({ running: 1, queued: 1 });
    await expect(queue.run(async () => "c")).rejects.toMatchObject({ reason: "queue_full" });
    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });

  it("a waiter that waits too long is refused with wait_timeout and never runs", async () => {
    const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: 30 });
    const first = hold();
    const a = queue.run(() => first.promise);
    let ran = false;
    const error = await queue.run(async () => void (ran = true)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OverloadedError);
    expect(error).toMatchObject({ reason: "wait_timeout" });
    first.release();
    await a;
    expect(ran).toBe(false);
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });

  it("a waiter whose caller leaves is removed and never runs", async () => {
    const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 2, maxWaitMs: 1_000 });
    const first = hold();
    const a = queue.run(() => first.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = queue.run(async () => void (ran = true), controller.signal);
    expect(queue.stats.queued).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(queue.stats.queued).toBe(0);
    first.release();
    await a;
    expect(ran).toBe(false);
  });

  it("a task that throws still frees its slot", async () => {
    const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("UsageMeter", () => {
  const usage = { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  it("without pricing, cost is unavailable — not zero, even though the SDK reports 0", () => {
    const meter = new UsageMeter(undefined);
    meter.record(usage);
    expect(meter.report()).toMatchObject({ modelCalls: 1, inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, cost: { usd: "unavailable" } });
  });

  it("with configured pricing, cost is computed from the tokens", () => {
    const meter = new UsageMeter({ inputPerMTokUsd: 2, outputPerMTokUsd: 10 });
    meter.record(usage);
    meter.record(usage);
    expect(meter.report().cost).toEqual({ usd: (2_000 * 2 + 1_000 * 10) / 1_000_000, source: "configured-pricing" });
  });

  it("pricing from the environment needs both prices to be numbers", () => {
    expect(pricingFromEnvironment({ PRICE_INPUT_PER_MTOK: "1", PRICE_OUTPUT_PER_MTOK: "4" })).toEqual({ inputPerMTokUsd: 1, outputPerMTokUsd: 4 });
    expect(pricingFromEnvironment({ PRICE_INPUT_PER_MTOK: "1", PRICE_OUTPUT_PER_MTOK: "" })).toBeUndefined();
    expect(pricingFromEnvironment({ PRICE_INPUT_PER_MTOK: "x", PRICE_OUTPUT_PER_MTOK: "4" })).toBeUndefined();
    expect(pricingFromEnvironment({})).toBeUndefined();
  });
});

describe("failure taxonomy", () => {
  it("only transient categories are retryable; refusals, defects, and our own stops are not", () => {
    expect([...RETRYABLE_CATEGORIES].sort()).toEqual(["network_error", "rate_limited", "timeout", "unavailable"]);
    for (const category of FAILURE_CATEGORIES) expect(new ConnectorFailure(category, "x").retryable).toBe(RETRYABLE_CATEGORIES.has(category));
  });

  it("parseRetryAfter reads seconds and HTTP dates and ignores nonsense", () => {
    expect(parseRetryAfter("5", NOW)).toBe(5_000);
    expect(parseRetryAfter("Sun, 20 Sep 2026 00:00:04 GMT", NOW)).toBe(4_000);
    expect(parseRetryAfter("Sat, 19 Sep 2026 00:00:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});
