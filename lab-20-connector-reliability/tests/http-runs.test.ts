import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { FULL_ACCESS_TOKEN, TENANT_A_ONLY_TOKEN } from "../src/fake-api/server.js";
import { callThenAnswer, eventually, lookup, say, sleepMs, startHarness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * The whole path — HTTP front door, authentication, admission queue, the real Pi harness driven by a
 * scripted model, the connector, and the local fake API. The model is a script: these tests show what
 * the *application* guarantees about limits, failures, and honesty of the result. They say nothing
 * about how a real model would behave.
 */
let h: Harness;
afterEach(async () => {
  await h?.close();
});

const start = async (options: HarnessOptions = {}) => (h = await startHarness(options));
const alice = () => h.as("tenant-a", "alice");
const toolText = (callIndex: number) => h.toolResultsIn(callIndex).join("\n");

describe("a successful lookup", () => {
  it("answers from the live booking service, quoting values the application computed", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "BK1001 is booked; total weight 52250 kg; cutoff not passed."));
    const res = await alice().chat("Tell me about BK1001");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "completed", capabilities: ["lookup_booking"], data: { completeness: "complete", stale: false } });
    expect(res.body.answer).toBe("BK1001 is booked; total weight 52250 kg; cutoff not passed."); // complete + fresh: no note added
    expect(toolText(1)).toContain("total_weight_kg=52250");
    expect(toolText(1)).toContain("cutoff_passed=false");
  });

  it("a passed cutoff is computed by the application, not left to the model", async () => {
    await start();
    h.script(callThenAnswer("BK2001", "The cutoff has passed."));
    await alice().chat("BK2001?");
    expect(toolText(1)).toContain("cutoff_passed=true");
  });

  it("request, tool call, connector attempts, and the API's own log all carry the same identities", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "done"));
    const res = await alice().chat("BK1001?");
    const { requestId, connector, budget, usage } = res.body;
    expect(connector.attempts).toHaveLength(4); // the booking, then three container pages
    expect(connector.attempts.every((attempt: any) => attempt.requestId === requestId && attempt.outcome === "ok")).toBe(true);
    expect(new Set(connector.attempts.map((attempt: any) => attempt.toolCallId)).size).toBe(1);
    expect(h.api.log.map((entry) => [entry.requestId, entry.toolCallId, entry.opId, entry.attempt])).toEqual(
      connector.attempts.map((attempt: any) => [attempt.requestId, attempt.toolCallId, attempt.opId, attempt.attempt]),
    );
    expect(budget.usage).toEqual({ turns: 2, toolCalls: 1, pages: 3, connectorAttempts: 4 });
    expect(usage.modelCalls).toBe(2);
  });

  it("colliding booking numbers resolve by the caller's tenant, and one tenant's data never reaches the other's model", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "done"));
    const res = await h.as("tenant-b", "erin").chat("BK1001?");
    expect(res.status).toBe(200);
    expect(toolText(1)).toContain("total_weight_kg=60000");
    expect(JSON.stringify(h.providerCalls)).not.toMatch(/52250|MSKU/);
    expect(h.api.log.every((entry) => entry.tenant === "tenant-b")).toBe(true);
  });

  it("a principal with no roles is offered no tool, and a tool call it makes anyway never reaches the API", async () => {
    await start();
    h.app.directory.revokeRole("tenant-a", "carol", "viewer");
    h.script(callThenAnswer("BK1001", "done"));
    const res = await h.as("tenant-a", "carol").chat("BK1001?");
    expect(res.body.capabilities).toEqual([]);
    expect(h.api.log).toEqual([]);
  });

  it("a booking that does not exist is reported as no result, without retries", async () => {
    await start();
    h.script(callThenAnswer("BK9999", "There is no BK9999."));
    const res = await alice().chat("BK9999?");
    expect(res.body.data.completeness).toBe("no_result");
    expect(toolText(1)).toContain("NO_RESULT: no booking BK9999");
    expect(h.api.log).toHaveLength(1);
  });
});

describe("dependency failures are reported as what they are", () => {
  it("403 is not retried; the model is told so, and the result says the data is unavailable", async () => {
    await start({ app: { connector: { credential: () => TENANT_A_ONLY_TOKEN } } });
    h.script(callThenAnswer("BK1001", "I could not retrieve BK1001."));
    const res = await h.as("tenant-b", "erin").chat("BK1001?");
    expect(res.body).toMatchObject({ status: "completed", data: { completeness: "unavailable", lookups: [{ outcome: "failed", failure: { category: "forbidden", attempts: 1 } }] } });
    expect(toolText(1)).toContain("category=forbidden");
    expect(toolText(1)).toMatch(/Do not call lookup_booking again/);
    expect(res.body.answer).toContain("[Application note]");
    expect(h.api.log).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("429 with Retry-After is retried after that wait, and the run still completes", async () => {
    await start();
    h.api.inject({ kind: "status", status: 429, retryAfter: "2" }, { route: "booking" });
    h.script(callThenAnswer("BK1001", "done"));
    const res = await alice().chat("BK1001?");
    expect(res.body.data.completeness).toBe("complete");
    expect(h.sleeps).toEqual([2000]);
    expect(res.body.connector.attempts.slice(0, 2).map((attempt: any) => attempt.outcome)).toEqual(["rate_limited", "ok"]);
  });

  it("a persistent 503 exhausts the connector's attempts (and only those) and is reported as unavailable", async () => {
    await start();
    h.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    h.script(callThenAnswer("BK1001", "The service is down."));
    const res = await alice().chat("BK1001?");
    expect(toolText(1)).toContain("category=unavailable attempts=3");
    expect(res.body.data.completeness).toBe("unavailable");
    expect(h.api.log).toHaveLength(3);
    expect(h.sleeps).toEqual([10, 20]);
  });

  it("malformed JSON is a failure, not data, and is not retried", async () => {
    await start();
    h.api.inject({ kind: "malformed-json" }, { route: "booking" });
    h.script(callThenAnswer("BK1001", "bad data"));
    const res = await alice().chat("BK1001?");
    expect(toolText(1)).toContain("category=malformed_response");
    expect(res.body.data.lookups[0].failure).toMatchObject({ category: "malformed_response", attempts: 1 });
    expect(h.api.log).toHaveLength(1);
  });

  it("a tool that outlives its own timeout fails that call; the run goes on and can still answer", async () => {
    await start({ app: { limits: { toolTimeoutMs: 150 }, connector: { retry: { attemptTimeoutMs: 5_000 } } } });
    h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    h.script(callThenAnswer("BK1001", "The lookup timed out."));
    const res = await alice().chat("BK1001?");
    expect(res.body).toMatchObject({ status: "completed", data: { completeness: "unavailable", lookups: [{ failure: { category: "deadline_exceeded" } }] } });
    await eventually(() => h.api.log[0]?.clientAborted === true);
  });

  it("partial data is never presented as complete: no total reaches the model, and the result says so even if the model's prose does not", async () => {
    await start();
    h.api.inject({ kind: "status", status: 503 }, { route: "containers", page: 2 }, Infinity);
    // The scripted model ignores the warning and states a total anyway.
    h.script(callThenAnswer("BK1001", "BK1001 has a total weight of 52250 kg."));
    const res = await alice().chat("BK1001 total weight?");
    expect(toolText(1)).toContain("LOOKUP_PARTIAL");
    expect(toolText(1)).toContain("total_weight_kg=UNKNOWN");
    expect(toolText(1)).not.toMatch(/total_weight_kg=\d/);
    expect(res.body.data).toMatchObject({ completeness: "partial", lookups: [{ outcome: "partial", totalWeightKg: null, containersRetrieved: 2, containersExpected: 5 }] });
    // The application cannot stop the model saying it, but the response flags it as unconfirmed.
    expect(res.body.answer).toContain("52250");
    expect(res.body.answer).toMatch(/\[Application note\].*incomplete/);
  });

  it("a stale record is flagged in the tool result and in the application note", async () => {
    await start();
    h.script(callThenAnswer("BK4001", "BK4001 is booked."));
    const res = await alice().chat("BK4001?");
    expect(toolText(1)).toMatch(/freshness=STALE/);
    expect(res.body.data.stale).toBe(true);
    expect(res.body.answer).toMatch(/out of date/);
  });
});

describe("execution budgets", () => {
  it("tool-call limit: the call over the limit is refused before dispatch, and the model can still answer", async () => {
    await start({ app: { limits: { maxToolCalls: 1 } } });
    h.script([lookup("BK1001"), lookup("BK2001"), say("Only BK1001 was looked up.")]);
    const res = await alice().chat("BK1001 and BK2001?");
    expect(res.body).toMatchObject({ status: "completed", budget: { usage: { toolCalls: 1 }, exhausted: ["tool_calls"] } });
    expect(toolText(2)).toContain("BUDGET_EXHAUSTED");
    expect(new Set(h.api.log.map((entry) => entry.bookingNo))).toEqual(new Set(["BK1001"])); // BK2001 was never requested
    expect(res.body.answer).toMatch(/refused by request limits \(tool-call\)/);
  });

  it("turn limit: the model call that would exceed it was not dispatched (observed — see the repeated-runs test); the result is incomplete and application-written", async () => {
    await start({ app: { limits: { maxTurns: 2 } } });
    h.script([lookup("BK1001"), lookup("BK2001"), say("never reached")]);
    const res = await alice().chat("both?");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "incomplete", incomplete: { kind: "budget", dimension: "turns" }, budget: { usage: { turns: 2 } } });
    expect(h.providerCalls).toHaveLength(2);
    expect(res.body.answer).toMatch(/did not finish.*turn limit/);
    expect(res.body.answer).toContain("BK1001: complete");
    expect(res.body.answer).not.toContain("never reached");
  });

  it("page budget: a listing stops at the run's page limit and is reported as partial with the reason", async () => {
    await start({ app: { limits: { maxPages: 3 } } });
    h.script(callThenAnswer("BK3001", "partial"));
    const res = await alice().chat("BK3001?");
    expect(h.api.requestsFor("containers")).toHaveLength(3);
    expect(toolText(1)).toMatch(/pages budget was used up before page 4/);
    expect(res.body.data).toMatchObject({ completeness: "partial", lookups: [{ containersRetrieved: 6, containersExpected: 12, incomplete: { kind: "budget", dimension: "pages" } }] });
  });

  it("attempt budget spans tool calls: the model calling the tool again cannot multiply connector retries", async () => {
    await start({ app: { limits: { maxConnectorAttempts: 4, maxToolCalls: 4 } } });
    h.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
    h.script([lookup("BK1001"), lookup("BK1001"), lookup("BK1001"), say("gave up")]);
    const res = await alice().chat("BK1001?");
    // Without the run-level cap this is 3 tool calls x 3 attempts = 9 requests.
    expect(h.api.log).toHaveLength(4);
    expect(res.body.budget.usage.connectorAttempts).toBe(4);
    expect(res.body.data.lookups.map((entry: any) => [entry.failure.category, entry.failure.attempts])).toEqual([
      ["unavailable", 3],
      ["budget_exhausted", 1],
      ["budget_exhausted", 0],
    ]);
  });

  it("output limit: a response cut off at the length limit is an incomplete result, not a finished answer", async () => {
    await start();
    h.script([fauxAssistantMessage(fauxText("The booking is"), { stopReason: "length" })]);
    const res = await alice().chat("BK1001?");
    expect(res.body).toMatchObject({ status: "incomplete", incomplete: { kind: "output_limit" } });
    expect(res.body.answer).toContain("The booking is");
    expect(res.body.answer).toMatch(/cut off/);
  });

  it("output cap: the model the harness sends with carries the configured response limit", async () => {
    await start({ app: { limits: { maxOutputTokens: 123 } } });
    h.script(callThenAnswer("BK1001", "done"));
    await alice().chat("BK1001?");
    expect(h.providerCalls.map((call) => call.model.maxTokens)).toEqual([123, 123]);
  });

  it("context limit: an over-limit request leaves only as a placeholder — no booking data reaches the provider — and the run is ended", async () => {
    // Measure the real request sizes first: the system message carries the prompt *and* the tool declaration.
    await start();
    h.script(callThenAnswer("BK1001", "measured"));
    await alice().chat("BK1001?");
    const [first, second] = h.providerCalls.map((call) => JSON.stringify(call.messages).length);
    expect(second).toBeGreaterThan(first!);
    await h.close();

    await start({ app: { limits: { maxContextChars: Math.floor((first! + second!) / 2) } } });
    h.script(callThenAnswer("BK1001", "never delivered"));
    const res = await alice().chat("BK1001?");
    expect(res.body).toMatchObject({ status: "incomplete", incomplete: { kind: "budget", dimension: "context" } });
    expect(res.body.budget.exhausted).toContain("context");
    expect(res.body.answer).not.toContain("never delivered");
    // Aborting races the dispatch (the abort is a commit; the request is already being sent), so the
    // over-limit request MAY go out. What is guaranteed is what it carries: the placeholder, not the session.
    expect(h.providerCalls.length).toBeLessThanOrEqual(2);
    for (const call of h.providerCalls.slice(1)) {
      expect(call.messages).toEqual([{ role: "user", content: expect.stringContaining("request withheld by the application"), timestamp: 0 }]);
      expect(JSON.stringify(call.messages)).not.toMatch(/MSKU|52250|BK1001/);
    }
    expect(JSON.stringify(h.providerCalls.slice(1))).not.toContain("total_weight_kg"); // the tool result never left
  });

  it("the context limit counts the whole session: once history alone exceeds it, every later request on that session is incomplete, and the note says to start a new session", async () => {
    await start();
    h.script([say("first")]);
    const opening = await alice().chat("hello");
    h.script([say("second")]);
    await alice().chat("hello again", { sessionId: opening.body.sessionId });
    const [s1, s2] = h.providerCalls.map((call) => JSON.stringify(call.messages).length);
    expect(s2).toBeGreaterThan(s1!);
    await h.close();

    await start({ app: { limits: { maxContextChars: Math.floor((s1! + s2!) / 2) } } });
    h.script([say("first")]);
    const first = await alice().chat("hello");
    expect(first.body.status).toBe("completed"); // a short request fits
    for (const attempt of [1, 2]) {
      h.script([say("never delivered")]);
      const later = await alice().chat("hello again", { sessionId: first.body.sessionId });
      expect(later.body, `attempt ${attempt}`).toMatchObject({ status: "incomplete", incomplete: { kind: "budget", dimension: "context" } });
      expect(later.body.answer).toContain("start a new session");
    }
    // A new session starts clean.
    h.script([say("fresh")]);
    expect((await alice().chat("hello")).body.status).toBe("completed");
  });

  it("a tool result is cut to its size limit with an explicit marker; the computed figures are still whole", async () => {
    await start({ app: { limits: { maxToolResultChars: 420 } } });
    h.script(callThenAnswer("BK1001", "done"));
    await alice().chat("BK1001?");
    expect(toolText(1)).toMatch(/TRUNCATED: \d+ more container/);
    expect(toolText(1)).toContain("total_weight_kg=52250");
  });

  it("run deadline: the run is stopped, the in-flight request is aborted at the API, and the result says the run timed out", async () => {
    await start({ app: { limits: { runDeadlineMs: 250 }, connector: { retry: { attemptTimeoutMs: 5_000 } } } });
    h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    h.script(callThenAnswer("BK1001", "never"));
    const started = Date.now();
    const res = await alice().chat("BK1001?");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "incomplete", incomplete: { kind: "run_deadline" } });
    await eventually(() => h.api.log[0]?.clientAborted === true); // cancellation propagated: Pi -> tool -> connector -> socket
    expect(h.api.log).toHaveLength(1);
  });
});

describe("usage and cost", () => {
  it("reports token usage; cost is unavailable without configured pricing", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "done"));
    const res = await alice().chat("BK1001?");
    expect(res.body.usage).toMatchObject({ modelCalls: 2, cost: { usd: "unavailable" } });
    expect(res.body.usage.totalTokens).toBeGreaterThan(0);
  });

  it("computes cost from configured pricing and the reported tokens", async () => {
    await start({ app: { pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 10 } } });
    h.script(callThenAnswer("BK1001", "done"));
    const { usage } = (await alice().chat("BK1001?")).body;
    expect(usage.cost).toEqual({ usd: (usage.inputTokens * 2 + usage.outputTokens * 10) / 1_000_000, source: "configured-pricing" });
  });
});

describe("model calls", () => {
  it("a provider failure is a failed run (502), never an answer; provider retries are owned by the harness alone", async () => {
    await start({ app: { modelCall: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, requestTimeoutMs: 4321 } } });
    const failing = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" });
    h.script([failing, failing, failing]);
    const res = await alice().chat("BK1001?");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("run_failed");
    expect(h.runFailures.join()).toMatch(/provider error/);
    expect(h.providerCalls).toHaveLength(2); // one call + one harness retry, not 1 + 3 (default) and not multiplied by an SDK layer
    expect(h.providerCalls[0]?.options).toMatchObject({ maxRetries: 0, timeoutMs: 4321 });
  });
});

describe("cancellation and overload", () => {
  it("a client that disconnects mid-run cancels it: the API request is aborted and no capacity leaks", async () => {
    // Every timer that could end the hang on its own is set far away, so only cancellation can abort the request.
    await start({ app: { limits: { runDeadlineMs: 60_000, toolTimeoutMs: 60_000 }, connector: { retry: { attemptTimeoutMs: 60_000 } } } });
    h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    h.script(callThenAnswer("BK1001", "never"));
    const controller = new AbortController();
    const pending = alice().chat("BK1001?", { signal: controller.signal }).catch((error: unknown) => error);
    await eventually(() => h.api.log.length === 1);
    const abortedAt = Date.now();
    controller.abort();
    await pending;
    await eventually(() => h.api.log[0]?.clientAborted === true, 1_000);
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    await eventually(() => h.outcomes.some((entry) => entry.outcome === "cancelled"));
    expect(h.providerCalls).toHaveLength(1); // no model call after the client left
    expect(h.app.queue.stats).toEqual({ running: 0, queued: 0 });

    h.api.clearFaults();
    h.script(callThenAnswer("BK1001", "fine now"));
    expect((await alice().chat("BK1001?")).body.status).toBe("completed");
  });

  const saturate = async () => {
    await start({ app: { queue: { maxConcurrent: 1, maxQueued: 1, maxWaitMs: 3_000, retryAfterSeconds: 3 } } });
    h.api.inject({ kind: "delay", ms: 300 }, { route: "booking" });
    h.script([lookup("BK1001"), say("first"), lookup("BK1001"), say("second")]);
    const first = alice().chat("one");
    await eventually(() => h.api.log.length === 1); // the first run is executing
    const second = alice().chat("two");
    await eventually(() => h.app.queue.stats.queued === 1);
    return { first, second };
  };

  it("a full queue is an explicit 503 with Retry-After — no model call, no API call — and the admitted runs still finish", async () => {
    const { first, second } = await saturate();
    const refused = await alice().chat("three");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("3");
    expect(refused.body).toMatchObject({ error: "overloaded", reason: "queue_full" });
    expect(h.providerCalls.length).toBeLessThanOrEqual(2); // nothing was spent on the refused request
    expect((await first).body.answer).toBe("first");
    expect((await second).body.answer).toBe("second");
    expect(h.outcomes.map((entry) => entry.outcome).sort()).toEqual(["completed", "completed", "overloaded"]);
  });

  it("authentication happens before admission: an unauthenticated request gets 401 even when the queue is full", async () => {
    const { first, second } = await saturate();
    const res = await h.postRaw({}, { message: "hi" });
    expect(res.status).toBe(401);
    expect(h.app.queue.stats).toEqual({ running: 1, queued: 1 });
    await Promise.all([first, second]);
  });

  it("a request that leaves the queue never runs", async () => {
    await start({ app: { queue: { maxConcurrent: 1, maxQueued: 1, maxWaitMs: 3_000 } } });
    h.api.inject({ kind: "delay", ms: 250 }, { route: "booking" });
    h.script([lookup("BK1001"), say("first")]);
    const first = alice().chat("one");
    await eventually(() => h.api.log.length === 1);
    const controller = new AbortController();
    const second = alice().chat("two", { signal: controller.signal }).catch((error: unknown) => error);
    await eventually(() => h.app.queue.stats.queued === 1);
    controller.abort();
    await second;
    await eventually(() => h.app.queue.stats.queued === 0);
    expect((await first).body.answer).toBe("first");
    await sleepMs(50);
    expect(h.providerCalls).toHaveLength(2); // only the first run's two model calls
  });

  it("a request that waits longer than the limit is refused with wait_timeout", async () => {
    await start({ app: { queue: { maxConcurrent: 1, maxQueued: 1, maxWaitMs: 80 } } });
    h.api.inject({ kind: "delay", ms: 400 }, { route: "booking" });
    h.script([lookup("BK1001"), say("first")]);
    const first = alice().chat("one");
    await eventually(() => h.api.log.length === 1);
    const refused = await alice().chat("two");
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: "overloaded", reason: "wait_timeout" });
    expect((await first).body.status).toBe("completed");
  });
});

describe("a booking has several containers", () => {
  it("the model is shown every container number with its weight, and the prompt says the status belongs to the booking as a whole", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "BK1001 has five containers."));
    await alice().chat("Which containers are on BK1001?");
    const shown = toolText(1);
    for (const containerNo of ["MSKU0000001", "MSKU0000002", "MSKU0000003", "MSKU0000004", "MSKU0000005"]) expect(shown).toContain(containerNo);
    expect(shown).toContain("containers: count=5");
    // The system message carries both the prompt (hard-wrapped, so compare with whitespace collapsed) and the tool declaration.
    const [system] = h.providerCalls[0]!.messages.filter((message) => message.role === "system") as unknown as Array<{ sections: { preamble: string }; toolsAdded: Array<{ description: string }> }>;
    expect(system!.sections.preamble.replace(/\s+/g, " ")).toContain("A booking can have several containers; report all of them, and remember that a status belongs to the booking as a whole");
    // The tool declaration says so too, so a model that never reads the prompt still knows.
    expect(system!.toolsAdded[0]!.description).toContain("A booking can have several containers");
  });

  it("a swapped container is reported as an identity mismatch with the names involved — and no total, although the count matches", async () => {
    await start();
    h.api.inject({ kind: "container-mismatch", mode: "swap" }, { route: "booking" });
    h.script(callThenAnswer("BK1001", "The data does not match."));
    const res = await alice().chat("BK1001 total weight?");
    expect(toolText(1)).toContain("LOOKUP_PARTIAL");
    expect(toolText(1)).toContain("missing: GHOST0000001");
    expect(toolText(1)).toContain("not on the booking: MSKU0000005");
    expect(toolText(1)).toContain("total_weight_kg=UNKNOWN");
    expect(res.body.data).toMatchObject({ completeness: "partial", lookups: [{ outcome: "partial", containersExpected: 5, containersRetrieved: 4, totalWeightKg: null }] });
  });
});

describe("the turn limit, observed repeatedly", () => {
  it("the model call that would exceed the limit was not dispatched in 12 of 12 runs (an observation: the abort races the next request, and the SDK does not promise it wins)", async () => {
    const dispatched: number[] = [];
    for (let run = 0; run < 12; run++) {
      await start({ app: { limits: { maxTurns: 2 } } });
      h.script([lookup("BK1001"), lookup("BK2001"), say("never reached")]);
      const res = await alice().chat("both?");
      expect(res.body).toMatchObject({ status: "incomplete", incomplete: { kind: "budget", dimension: "turns" } });
      dispatched.push(h.providerCalls.length);
      await h.close();
    }
    expect(dispatched).toEqual(Array(12).fill(2));
  });
});

describe("the service credential reaches nothing but the booking API", () => {
  it("it appears in no trace line, provider request, response body, or session file", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await start();
    h.api.inject({ kind: "status", status: 503 }, { route: "booking" }); // include a retry and a failure path in what is scanned
    h.script(callThenAnswer("BK1001", "done"));
    const res = await alice().chat("BK1001?");
    const files = (await readdir(h.dir, { recursive: true })).map(String).filter((name) => /\.(jsonl|json)$/.test(name) && !name.includes("issuer-keys"));
    const haystacks = [h.traceLines.join("\n"), JSON.stringify(h.providerCalls), JSON.stringify(res.body), ...(await Promise.all(files.map((name) => readFile(join(h.dir, name), "utf8").catch(() => ""))))];
    expect(files.some((name) => name.includes("sessions"))).toBe(true); // positive control: session files were really scanned
    for (const text of haystacks) expect(text).not.toContain(FULL_ACCESS_TOKEN);
    // Positive control: the API itself did receive it, so the scan is looking for the right string.
    expect(h.api.log.length).toBeGreaterThan(0);
  });
});
