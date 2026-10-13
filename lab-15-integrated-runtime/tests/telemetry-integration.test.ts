import { describe, expect, it } from "vitest";

import { listEntries } from "../src/transcript.js";
import { answerTurn, ctx, scriptedRuntime, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * Lab 14's bridge, run against the composed runtime. Pi 1.1 opens no spans of its own, so every span below is
 * the bridge's reconstruction from the committed event stream (`lab.*`, not `pi.*`).
 */
describe("telemetry in the composed runtime", () => {
  it("nests ai.request and tool spans under a turn under a run, and closes them all", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("ok"));

    const result = await h.runtime.request("req-1", "go");

    const spans = h.telemetry.getSpans();
    const byName = (name: string) => spans.filter((s) => s.name === name);
    const [run] = byName("lab.run");
    expect(byName("lab.run")).toHaveLength(1);
    expect(byName("lab.turn")).toHaveLength(2);
    expect(byName("lab.turn").every((t) => t.parentId === run?.id)).toBe(true);
    expect(byName("lab.ai.request")).toHaveLength(2);
    expect(spans.every((s) => s.settled)).toBe(true);
    expect(result.mechanism.problems).toEqual([]);
  });

  it("each provider-request span carries its own message's usage — usage is on the committed message, so there is nothing to mis-correlate", async () => {
    const h = await scriptedRuntime();
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("BK1001 is booked."));

    await h.runtime.request("req-usage", "Status of BK1001?");

    const assistantTokens = (await listEntries(h.runtime.root, ctx))
      .map((e) => e.model?.[0])
      .flatMap((m) => (m?.role === "assistant" ? [m.usage.totalTokens] : []));
    const spanTokens = h.telemetry.getSpans().filter((s) => s.name === "lab.ai.request").map((s) => s.attributes["lab.ai.usage.total_tokens"]);

    expect(assistantTokens).toHaveLength(2);
    expect(new Set(assistantTokens).size).toBe(2); // distinct, so a mis-attribution cannot pass by coincidence
    expect(spanTokens).toEqual(assistantTokens);
  });

  it("records a call that ran as 'result' and a call Pi refused as 'refused' — the two differ only in whether a start event existed", async () => {
    const ran = await scriptedRuntime();
    ran.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "c1"), answerTurn("ok"));
    await ran.runtime.request("req-ran", "go");

    const blocked = await scriptedRuntime();
    blocked.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "cancelled" }, "c1"), answerTurn("no"));
    await blocked.runtime.request("req-blocked", "go");

    const tool = (h: typeof ran) => h.telemetry.getSpans().find((s) => s.name === "lab.tool");
    expect(tool(ran)?.attributes).toMatchObject({ "lab.tool.outcome": "result", "lab.tool.is_error": false });
    expect(tool(blocked)?.attributes).toMatchObject({ "lab.tool.outcome": "refused", "lab.tool.is_error": true });
    expect(blocked.runtime.auditRecords[0]?.decision).toBe("blocked"); // only the audit says it was a policy decision
  });

  it("adds one run span per request on a shared telemetry context", async () => {
    const h = await scriptedRuntime();
    h.respondWith(answerTurn("one"), answerTurn("two"));

    await h.runtime.request("req-1", "first");
    await h.runtime.request("req-2", "second");

    expect(h.telemetry.getSpans().filter((s) => s.name === "lab.run")).toHaveLength(2);
  });

  it("a refused (egress) request opens no run span and is not a mechanism failure", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: [{ label: "x", value: "SECRET-X" }] } });
    h.respondWith(answerTurn("never"));

    const result = await h.runtime.request("req-refused", "contains SECRET-X");

    expect(result.operation.status).toBe("rejected");
    expect(h.telemetry.getSpans()).toEqual([]);
    expect(result.mechanism.ok).toBe(true);
  });
});
