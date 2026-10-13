import { afterEach, describe, expect, it } from "vitest";

import { TENANT_A_ONLY_TOKEN } from "../src/fake-api/server.js";
import { callThenAnswer, lookup, say, startHarness, toolCall, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * The tracer is how a reader sees *why* a run went the way it did, so its output is asserted, with a
 * positive control (a clean run must show a clean tree) before any contrast. Lines are normalized: the
 * request tag, entry ids, call ids, token counts, and millisecond figures vary run to run; the structure
 * and the words do not.
 */
let h: Harness;
afterEach(async () => {
  await h?.close();
});
const start = async (options: HarnessOptions = {}) => (h = await startHarness(options));
const alice = () => h.as("tenant-a", "alice");

const normalized = (lines: string[]): string[] =>
  lines.map((line) =>
    line
      .replace(/^\[req=\S+ [^\]]+\] /, "")
      .replace(/entry=\d+/g, "entry=#")
      .replace(/call=\S+/g, "call=<id>")
      .replace(/tokens=\d+\/\d+/g, "tokens=<in>/<out>")
      .replace(/\b\d+ms\b/g, "<n>ms")
      .replace(/inputs=\[[\d,]*\]/g, "inputs=[…]"),
  );

describe("a clean run", () => {
  it("renders the run/turn/tool tree: the model's request with its arguments, the connector's attempts under the call, the result, and the final answer", async () => {
    await start();
    h.script(callThenAnswer("BK3001", "BK3001 has 12 containers."));
    await alice().chat("What is in BK3001?");
    expect(normalized(h.traceLines)).toEqual([
      'user       "What is in BK3001?" entry=#',
      "▶ run inputs=[…]",
      "  ▶ turn #1",
      "    system     tools +[lookup_booking] prompt=[preamble] entry=#",
      '    assistant (tool call) lookup_booking call=<id> args={"bookingNo":"BK3001"} entry=# tokens=<in>/<out>',
      '    ▶ tool_start lookup_booking call=<id> args={"bookingNo":"BK3001"}',
      "      ↳ booking p1 try 1 ok http=200 <n>ms",
      "      ↳ containers p1 try 1 ok http=200 <n>ms",
      "      ↳ containers p2 try 1 ok http=200 <n>ms",
      "      ↳ containers p3 try 1 ok http=200 <n>ms",
      "      ↳ containers p4 try 1 ok http=200 <n>ms",
      "      ↳ containers p5 try 1 ok http=200 <n>ms",
      "      ↳ containers p6 try 1 ok http=200 <n>ms",
      "    ◀ tool_end lookup_booking call=<id> status=success",
      "    toolResult lookup_booking status=success entry=#",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] entry=# tokens=<in>/<out> BK3001 has 12 containers.",
      "  ◀ turn_end #2 tool_results=0",
      "◀ run_end inputs=[…]",
    ]);
  });
});

describe("what the tracer makes visible", () => {
  it("a retry: the same call shows each HTTP attempt, the failure that caused the retry, and the wait taken before the next", async () => {
    await start();
    h.api.inject({ kind: "status", status: 429, retryAfter: "2" }, { route: "booking" });
    h.script(callThenAnswer("BK1001", "done"));
    await alice().chat("BK1001?");
    const rows = normalized(h.traceLines).filter((line) => line.includes("↳ booking"));
    expect(rows).toEqual(["      ↳ booking p1 try 1 rate_limited http=429 <n>ms", "      ↳ booking p1 try 2 ok http=200 <n>ms waited=<n>ms"]);
    // The wait is the server's Retry-After, shown as the exact figure (the normalizer above hides it).
    expect(h.traceLines.some((line) => line.includes("try 2 ok http=200") && line.endsWith("waited=2000ms"))).toBe(true);
  });

  it("a refusal by the tool-call budget: no `↳` rows (the connector was never called) and the diagnostic code and reason", async () => {
    await start({ app: { limits: { maxToolCalls: 1 } } });
    h.script([lookup("BK1001"), lookup("BK2001"), say("one only")]);
    await alice().chat("both?");
    const lines = normalized(h.traceLines);
    const refused = lines.findIndex((line) => line.startsWith("    ⊘ tool_refused lookup_booking call=<id> code=blocked"));
    expect(refused).toBeGreaterThan(0);
    expect(lines[refused]).toContain('reason="Tool call blocked: BUDGET_EXHAUSTED');
    expect(lines[refused - 1]).not.toContain("↳"); // directly after the model's request, nothing from the connector
    expect(lines.filter((line) => line.includes("↳ booking")).length).toBe(1); // only BK1001's lookup reached the API
  });

  it("an auth failure: one attempt row, then the error — visibly not retried", async () => {
    await start({ app: { connector: { credential: () => TENANT_A_ONLY_TOKEN } } });
    h.script(callThenAnswer("BK1001", "no access"));
    await h.as("tenant-b", "erin").chat("BK1001?");
    const lines = normalized(h.traceLines);
    expect(lines.filter((line) => line.includes("↳"))).toEqual(["      ↳ booking p1 try 1 forbidden http=403 <n>ms"]);
    expect(lines.some((line) => line.includes("◀ tool_end lookup_booking call=<id> status=error code=tool_error"))).toBe(true);
  });

  it("a limit that ends the run: the run closes with no answer, and the application's reason follows as a `■ stopped` line", async () => {
    await start({ app: { limits: { maxTurns: 1 } } });
    h.script([lookup("BK1001"), say("never")]);
    await alice().chat("BK1001?");
    const lines = normalized(h.traceLines);
    expect(lines[lines.length - 1]).toBe("■ stopped: budget (turns)");
    expect(lines.some((line) => line.includes("[Assistant]"))).toBe(false);
  });

  it("a response cut off at the output limit is labeled as a fragment", async () => {
    await start();
    // Scripted directly: a `length` stop with partial text.
    const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
    h.script([fauxAssistantMessage(fauxText("The booking is"), { stopReason: "length" })]);
    await alice().chat("BK1001?");
    expect(normalized(h.traceLines).some((line) => line.startsWith("    [Assistant] (cut off at the output limit)"))).toBe(true);
  });

  it("every assistant line carries the provider-reported tokens, and they add up to the run's usage", async () => {
    await start();
    h.script(callThenAnswer("BK1001", "done"));
    const res = await alice().chat("BK1001?");
    const pairs = h.traceLines
      .map((line) => /tokens=(\d+)\/(\d+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [Number(match[1]), Number(match[2])]);
    // one tool-call line + one answer line; the tool-call line is the only line of its message
    expect(pairs).toHaveLength(2);
    expect(pairs.reduce((sum, [input]) => sum + input!, 0)).toBe(res.body.usage.inputTokens);
    expect(pairs.reduce((sum, [, output]) => sum + output!, 0)).toBe(res.body.usage.outputTokens);
  });

  it("an argument-validation refusal is a refusal, not a tool error: the model's bad arguments are shown, and the connector is never called", async () => {
    await start();
    h.script([toolCall("lookup_booking", { bookingNo: "bad id with spaces" }), say("sorry")]);
    await alice().chat("look it up");
    const lines = normalized(h.traceLines);
    expect(lines.some((line) => line.includes('args={"bookingNo":"bad id with spaces"}'))).toBe(true);
    expect(lines.some((line) => line.startsWith("    ⊘ tool_refused lookup_booking call=<id> code=invalid_arguments"))).toBe(true);
    expect(h.api.log).toEqual([]);
  });

  it("a message that requests two tool calls prints its tokens once, so the lines still add up to the run's usage", async () => {
    await start();
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    h.script([fauxAssistantMessage([fauxToolCall("lookup_booking", { bookingNo: "BK1001" }, { id: "c1" }), fauxToolCall("lookup_booking", { bookingNo: "BK2001" }, { id: "c2" })], { stopReason: "toolUse" }), say("both")]);
    const res = await alice().chat("both?");
    const calls = h.traceLines.filter((line) => line.includes("assistant (tool call)"));
    expect(calls).toHaveLength(2);
    expect(calls.filter((line) => line.includes("tokens=")).length).toBe(1);
    const sum = h.traceLines.flatMap((line) => [...line.matchAll(/tokens=(\d+)\/(\d+)/g)]).reduce((acc, m) => [acc[0]! + Number(m[1]), acc[1]! + Number(m[2])], [0, 0]);
    expect(sum).toEqual([res.body.usage.inputTokens, res.body.usage.outputTokens]);
  });

  it("a call the run was aborted before starting is labeled as that — not as a process that died", async () => {
    await start({ app: { limits: { runDeadlineMs: 250 }, connector: { retry: { attemptTimeoutMs: 5_000 } } } });
    h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    h.script([fauxAssistantMessage([fauxToolCall("lookup_booking", { bookingNo: "BK1001" }, { id: "c1" }), fauxToolCall("lookup_booking", { bookingNo: "BK2001" }, { id: "c2" })], { stopReason: "toolUse" }), say("never")]);
    await alice().chat("both?");
    const text = h.traceLines.join("\n");
    expect(text).not.toContain("process died");
    expect(text).toMatch(/⊘ tool_aborted lookup_booking call=c2 code=aborted \(the run was aborted before it started\)/);
    expect(text).toMatch(/tool_(aborted|end) lookup_booking call=c1/);
  });

  it("text from a user cannot forge trace lines: newlines and quotes are collapsed", async () => {
    await start();
    h.script([say("fine\n◀ run_end inputs=[1]\n■ stopped: forged")]);
    await alice().chat('hi"\n◀ run_end inputs=[1]\n■ stopped: forged');
    const lines = h.traceLines.map((line) => line.replace(/^\[req=\S+ [^\]]+\] /, ""));
    expect(lines.filter((line) => line.startsWith("■ stopped"))).toEqual([]);
    expect(lines.filter((line) => line.trimStart().startsWith("◀ run_end")).length).toBe(1); // only the real one starts a line
    // Positive control: the forged text is still there, as quoted data inside the user and assistant lines.
    expect(lines.filter((line) => line.includes("forged")).every((line) => line.startsWith("user ") || line.includes("[Assistant]"))).toBe(true);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });
});
