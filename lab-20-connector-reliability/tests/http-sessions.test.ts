import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";

import { createRequestRegistry, openHarness, offeredToolNames, type RunState } from "../src/create-harness.js";
import { AttemptTrace } from "../src/connector/trace.js";
import { DEFAULT_LIMITS, RunBudget } from "../src/run-budget.js";
import { mintSecurityContextForTest } from "../src/security-context.js";
import { UsageMeter } from "../src/usage-meter.js";
import { callThenAnswer, eventually, lookup, say, sleepMs, startHarness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * What changes when a session is REOPENED and when requests share one. In pi-durable 1.1 a conversation
 * stores only the *names* of its tools and extension, `root({ agent })` applies only at creation, and a
 * storage reads its entries when it is opened — so each of these is something the application has to do,
 * not something the SDK does for it.
 */
let h: Harness;
afterEach(async () => {
  await h?.close();
});
const start = async (options: HarnessOptions = {}) => (h = await startHarness(options));
const alice = () => h.as("tenant-a", "alice");

describe("a reopened session is governed by today's roles", () => {
  it("the stored offer is replaced, not restored: after the role is revoked the second request offers nothing, and a tool call is refused before the connector", async () => {
    await start();
    h.script([...callThenAnswer("BK1001", "first answer"), lookup("BK1001"), say("second answer")]);
    const first = await alice().chat("BK1001?");
    expect(first.body).toMatchObject({ capabilities: ["lookup_booking"], status: "completed" });
    const apiRequestsAfterFirst = h.api.log.length;

    h.app.directory.revokeRole("tenant-a", "alice", "operator");
    const second = await alice().chat("BK1001 again?", { sessionId: first.body.sessionId });
    expect(second.body).toMatchObject({ capabilities: [], status: "completed" });
    expect(second.body.data.lookups).toEqual([]);
    expect(h.api.log).toHaveLength(apiRequestsAfterFirst); // the connector was never reached
    expect(h.traceLines.join("\n")).toMatch(/⊘ tool_refused lookup_booking .* code=tool_unavailable/);
  });

  it("the offer is read back from the conversation, so 'offered' means what the next model request will list", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "ok"));
    const first = await alice().chat("BK1001?");
    h.app.directory.revokeRole("tenant-a", "alice", "operator");
    h.script([say("nothing offered")]);
    await alice().chat("hello", { sessionId: first.body.sessionId });
    // The second request's system messages: tools added in the first request, removed in this one.
    const messages = h.providerCalls[h.providerCalls.length - 1]!.messages as Array<{ role: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> }>;
    const added = messages.filter((m) => m.role === "system").flatMap((m) => (m.toolsAdded ?? []).map((tool) => `+${tool.name}`));
    const removed = messages.filter((m) => m.role === "system").flatMap((m) => (m.toolsRemoved ?? []).map((tool) => `-${tool.name}`));
    expect([...added, ...removed]).toEqual(["+lookup_booking", "-lookup_booking"]); // positive control: the fold sees both directions
  });

  it("a restored conversation keeps its history and its hooks: the budget and usage hooks fire again on the second request", async () => {
    await start({ app: { limits: { maxToolCalls: 1 } } });
    h.script(callThenAnswer("BK1001", "first answer"));
    const first = await alice().chat("BK1001?");
    expect(first.body.budget.usage.toolCalls).toBe(1);

    // A fresh request, a fresh budget of one tool call: the second call in it must be blocked by the hook.
    h.script([lookup("BK2001"), lookup("BK1001"), say("second answer")]);
    const second = await alice().chat("BK2001 and BK1001?", { sessionId: first.body.sessionId });
    expect(second.body.budget.usage.toolCalls).toBe(1);
    expect(second.body.budget.exhausted).toEqual(["tool_calls"]);
    expect(second.body.usage.modelCalls).toBe(3); // the meter counted this request's responses only
    const messages = JSON.stringify(h.providerCalls[2]!.messages);
    expect(messages).toContain("BK1001?"); // the first request's user message is in the restored context
    expect(messages).toContain("first answer");
  });

  it("another principal on the same session is refused, as before the port", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "ok"));
    const first = await alice().chat("BK1001?");
    const other = await h.as("tenant-a", "dave").chat("hi", { sessionId: first.body.sessionId });
    expect(other.status).toBe(404);
  });
});

describe("requests on one session are serialized", () => {
  it("two overlapping requests do not fork the history: the second sees the first's answer", async () => {
    await start();
    h.script([
      async () => {
        await sleepMs(200);
        return say("first answer");
      },
      say("second answer"),
    ]);
    const opening = await alice().chat("create the session"); // consumes script entry 0
    h.script([
      async () => {
        await sleepMs(200);
        return say("slow answer");
      },
      say("quick answer"),
    ]);
    const sessionId = opening.body.sessionId;
    const slow = alice().chat("slow question", { sessionId });
    await sleepMs(40); // the slow run is in flight when the next arrives
    const quick = alice().chat("quick question", { sessionId });
    const [a, b] = await Promise.all([slow, quick]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.answer).toBe("slow answer");
    expect(b.body.answer).toBe("quick answer");
    // The second request ran after the first finished, against the history that included its answer.
    const lastMessages = JSON.stringify(h.providerCalls[h.providerCalls.length - 1]!.messages);
    expect(lastMessages).toContain("slow question");
    expect(lastMessages).toContain("slow answer");
    expect(h.reports).toEqual([]);
  });

  it("different sessions are not serialized against each other", async () => {
    await start();
    h.script([
      async () => {
        await sleepMs(250);
        return say("a");
      },
      async () => {
        await sleepMs(250);
        return say("b");
      },
    ]);
    const started = Date.now();
    const [a, b] = await Promise.all([alice().chat("one"), h.as("tenant-b", "erin").chat("two")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Date.now() - started).toBeLessThan(450); // two 250 ms runs overlapped
  });
});

describe("a session with unsettled work from an earlier run", () => {
  it("is refused rather than run behind the old work under this request's budget", async () => {
    await start();
    // Leave a submission unsettled the way a crash would: a run whose process went away mid-flight.
    const security = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "crashed-run" });
    const resolved = h.app.sessions.resolve(security, undefined);
    const run: RunState = { budget: new RunBudget(DEFAULT_LIMITS), trace: new AttemptTrace(), meter: new UsageMeter(undefined), lookups: [], stopForBudget: () => undefined };
    const { storage } = await h.app.sessions.openStorage(resolved, BACKGROUND_CONTEXT);
    const registry = createRequestRegistry(security, h.app.capabilities, run);
    const opened = await openHarness(
      storage,
      { binding: h.app.binding, requestRegistry: registry, toolNames: offeredToolNames(security, h.app.directory), maxOutputTokens: 100 },
      BACKGROUND_CONTEXT,
    );
    h.faux.setResponses([
      async () => {
        await sleepMs(5_000);
        return say("never");
      },
    ]);
    await opened.root.submit({ type: "input", content: "interrupted question" }, BACKGROUND_CONTEXT);
    await sleepMs(50);
    await storage.close(BACKGROUND_CONTEXT); // the process "dies": the submission is never settled
    await eventually(() => true);

    h.script([say("should not run")]);
    const res = await alice().chat("a new question", { sessionId: resolved.sessionId });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("run_failed");
    expect(h.runFailures.join()).toMatch(/unsettled submission/);
    expect(h.providerCalls).toHaveLength(0); // the new request spent no model call
  });
});

describe("openHarness", () => {
  it("does not leak a created harness when wiring it fails: the harness is closed (which closes its storage) and the error still propagates", async () => {
    await start();
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const security = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "wiring" });
    const run: RunState = { budget: new RunBudget(DEFAULT_LIMITS), trace: new AttemptTrace(), meter: new UsageMeter(undefined), lookups: [], stopForBudget: () => undefined };
    const registry = createRequestRegistry(security, h.app.capabilities, run);

    // `Harness.open` only scans; creating the root conversation is the first write, which fails here.
    const closed: string[] = [];
    const inner = new MemoryStorage();
    const storage = new Proxy(inner, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "close") closed.push("storage.close");
          else if (property !== "scanTasks" && property !== "scanSubmissions") throw new Error(`injected failure in ${String(property)}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    await expect(
      openHarness(storage, { binding: h.app.binding, requestRegistry: registry, toolNames: ["lookup_booking"], maxOutputTokens: 100 }, BACKGROUND_CONTEXT),
    ).rejects.toThrow(/injected failure/);
    expect(closed).toEqual(["storage.close"]);
  });
});
