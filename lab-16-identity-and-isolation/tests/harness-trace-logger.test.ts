import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { TenantBookingStore } from "../src/booking-store.js";
import { createRequestRegistry, openHarness } from "../src/create-harness.js";
import { attachTraceLogger, type TraceOptions } from "../src/harness-trace-logger.js";
import { ScopedCache } from "../src/scoped-cache.js";
import { mintSecurityContextForTest } from "../src/security-context.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { createFauxModels, withTempSessionsRoot } from "./support.js";

const ctx = BACKGROUND_CONTEXT;
const alice = mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "req-1" });

// Entry and submission ids are one shared counter, and token counts come from the scripted provider, so
// neither is stable. The trace *shape* is what these tests pin down.
function normalize(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"))
    .map((line) => line.replace(/tokens=\d+/g, "tokens=N"));
}

async function traceOneTurn(responses: ReturnType<typeof fauxAssistantMessage>[], prompt: string, options: TraceOptions = {}) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(responses);

    const { storage } = await openSessionStorage(sessionsRoot, "tenant-a", "s1", ctx);
    const requestRegistry = createRequestRegistry({
      securityContext: alice,
      store: TenantBookingStore.fromDefaultFixture(),
      cache: new ScopedCache(),
    });
    const { harness, root } = await openHarness(storage, { binding: { models, selection }, requestRegistry }, ctx);

    const lines: string[] = [];
    const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx, options);
    const settled = await (await root.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
    await trace.settled(settled.id);
    await trace.stop();
    await harness.close(ctx);

    return { lines: normalize(lines), settled };
  });
}

describe("harness trace logger", () => {
  it("renders prompt -> tool call -> tool result -> answer as a run/turn tree, with the call's arguments", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("final answer"),
      ],
      "What are the details for booking BK1001?",
      { text: "full" },
    );

    expect(settled.status).toBe("done");
    expect(lines).toEqual([
      'user       "What are the details for booking BK1001?" entry=N',
      "▶ run inputs=[N]",
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N (stop=toolUse tokens=N)',
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking call=call-1 status=success",
      "    toolResult get_booking status=success entry=N",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      '    [Assistant] entry=N (stop=stop tokens=N) "final answer"',
      "  ◀ turn_end #2 tool_results=0",
      "◀ run_end inputs=[N]",
    ]);
  });

  // The model's request and Pi's execution are separate lines, paired by the shared `call=` id, so the
  // arguments the model asked for can be compared with the arguments Pi ran.
  it("prints preamble text and every requested tool call as separate lines, each paired with its execution", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(
          [
            fauxText("Let me check both."),
            fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }),
            fauxToolCall("get_booking", { bookingNo: "BK2001" }, { id: "call-2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "Check BK1001 and BK2001.",
      { text: "full" },
    );

    expect(settled.status).toBe("done");
    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=2") + 1);
    // Text first, then one line per requested call — never one in place of the other.
    expect(turnOne.filter((line) => line.includes("[Assistant]") || line.includes("assistant (tool call)"))).toEqual([
      '    [Assistant] entry=N (stop=toolUse tokens=N) "Let me check both."',
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N (stop=toolUse tokens=N)',
      '    assistant (tool call) get_booking call=call-2 args={"bookingNo":"BK2001"} entry=N (stop=toolUse tokens=N)',
    ]);
    // Each request is paired with its own execution by the call id and carries the same arguments.
    expect(turnOne).toContain('    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}');
    expect(turnOne).toContain('    ▶ tool_start get_booking call=call-2 args={"bookingNo":"BK2001"}');
    expect(turnOne).toContain("    ◀ tool_end get_booking call=call-1 status=success");
    expect(turnOne).toContain("    ◀ tool_end get_booking call=call-2 status=success");
  });

  it("by default prints only the length of message text, never the text or the tool result's content", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("BK1001 is on ALPHA EXPRESS in MSKU1111111 and MSKU1111112."),
      ],
      "Where is BK1001? My secret is hunter2.",
    );

    const text = lines.join("\n");
    expect(text).toContain("user       chars=38 entry=N");
    expect(text).toMatch(/\[Assistant\] entry=N \(stop=stop tokens=N\) chars=\d+/);
    for (const forbidden of ["hunter2", "ALPHA EXPRESS", "MSKU1111111", "MSKU1111112", "Where is"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("separates a refused call from one that ran and failed, and shows the diagnostic code of each", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(
          [
            fauxToolCall("get_booking", { bookingNo: "BK1001", tenantId: "tenant-b" }, { id: "call-1" }),
            fauxToolCall("get_booking", { bookingNo: "BK9999" }, { id: "call-2" }),
            fauxToolCall("drop_tables", {}, { id: "call-3" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "go",
    );

    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=3") + 1);
    // Order is commit order: the harness refuses an unknown tool at once, before it validates the others.
    expect(turnOne.filter((line) => line.includes("tool_refused") || line.includes("▶ tool_start") || line.includes("◀ tool_end"))).toEqual([
      expect.stringMatching(/^ {4}⊘ tool_refused drop_tables call=call-3 code=tool_unavailable reason="/),
      expect.stringMatching(/^ {4}⊘ tool_refused get_booking call=call-1 code=invalid_arguments reason="/),
      '    ▶ tool_start get_booking call=call-2 args={"bookingNo":"BK9999"}',
      "    ◀ tool_end get_booking call=call-2 status=error code=tool_error",
    ]);
    // A refused call never starts: exactly one tool_start for three calls.
    expect(turnOne.filter((line) => line.includes("▶ tool_start"))).toHaveLength(1);
    expect(turnOne.filter((line) => line.includes("toolResult"))).toEqual([
      "    toolResult drop_tables status=error code=tool_unavailable entry=N",
      "    toolResult get_booking status=error code=invalid_arguments entry=N",
      "    toolResult get_booking status=error code=tool_error entry=N",
    ]);
  });

  it("shows a provider failure on the assistant line, with its stop reason", async () => {
    const { lines, settled } = await traceOneTurn(
      [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })],
      "hello",
    );

    expect(settled.status).toBe("unanswered");
    expect(lines).toContain("    assistant (error) 401 invalid api key entry=N (stop=error tokens=N)");
  });

  it("prefixes every line with the tag, so one request is findable in a shared log", async () => {
    const { lines } = await traceOneTurn([fauxAssistantMessage("hi")], "hi", { tag: "req=1a2b3c4d tenant=tenant-a sub=alice" });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("[req=1a2b3c4d tenant=tenant-a sub=alice] "))).toBe(true);
  });

  // `stop()` only promises to stop future callbacks, so callers wait on `settled()` instead. It must not
  // hang forever if the terminal event never shows up.
  it("writes a visible warning instead of hanging when a submission never settles", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "tenant-a", "s1", ctx);
      const requestRegistry = createRequestRegistry({
        securityContext: alice,
        store: TenantBookingStore.fromDefaultFixture(),
        cache: new ScopedCache(),
      });
      const { harness, root } = await openHarness(storage, { binding: { models, selection }, requestRegistry }, ctx);

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
      await trace.settled(999 as unknown as SubmissionId, 20);
      await trace.stop();
      await harness.close(ctx);

      expect(lines).toEqual(["trace: no settle event for submission 999 within 20ms"]);
    }));
});
