import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { createBookingRuntime, openHarness } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { createFauxModels, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

// Entry and submission ids are one shared counter, and token counts come from the scripted provider, so
// neither is stable. The trace *shape* is what these tests pin down.
function normalize(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"))
    .map((line) => line.replace(/tokens=\d+/g, "tokens=N"));
}

async function traceOneTurn(responses: ReturnType<typeof fauxAssistantMessage>[], prompt: string) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(responses);

    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openHarness(storage, { models, selection, registry: createBookingRuntime().registry }, ctx);

    const lines: string[] = [];
    const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
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
      "    [Assistant] entry=N (stop=stop tokens=N) final answer",
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
            fauxText("Let me update it."),
            fauxToolCall("update_booking_status", { bookingNo: "BK1002", newStatus: "in_transit" }, { id: "call-1" }),
            fauxToolCall("get_booking", { bookingNo: "BAD_ID" }, { id: "call-2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "Mark BK1002 in transit and check BAD_ID.",
    );

    expect(settled.status).toBe("done");
    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=2") + 1);
    expect(turnOne).toEqual([
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      "    [Assistant] entry=N (stop=toolUse tokens=N) Let me update it.",
      '    assistant (tool call) update_booking_status call=call-1 args={"bookingNo":"BK1002","newStatus":"in_transit"} entry=N (stop=toolUse tokens=N)',
      '    assistant (tool call) get_booking call=call-2 args={"bookingNo":"BAD_ID"} entry=N (stop=toolUse tokens=N)',
      '    ▶ tool_start update_booking_status call=call-1 args={"bookingNo":"BK1002","newStatus":"in_transit"}',
      "    ◀ tool_end update_booking_status call=call-1 status=success",
      "    toolResult update_booking_status status=success entry=N",
      '    ▶ tool_start get_booking call=call-2 args={"bookingNo":"BAD_ID"}',
      "    ◀ tool_end get_booking call=call-2 status=error",
      "    toolResult get_booking status=error entry=N",
      "  ◀ turn_end #1 tool_results=2",
    ]);
  });

  it("shows a provider failure on the assistant line, with its stop reason", async () => {
    const { lines, settled } = await traceOneTurn(
      [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })],
      "What are the details for booking BK1001?",
    );

    expect(settled.status).toBe("unanswered");
    expect(lines).toContain("    assistant (error) 401 invalid api key entry=N (stop=error tokens=N)");
  });

  it("omits the duration when the assistant message carries none, instead of printing 0ms", async () => {
    const { lines } = await traceOneTurn([fauxAssistantMessage("hi")], "Say hi.");
    expect(lines.filter((line) => line.includes("[Assistant]")).every((line) => !line.includes("ms)"))).toBe(true);
  });

  // `stop()` only promises to stop future callbacks, so callers wait on `settled()` instead. It must not hang
  // forever if the terminal event never shows up.
  it("writes a visible warning instead of hanging when a submission never settles", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
      const { harness, root } = await openHarness(storage, { models, selection, registry: createBookingRuntime().registry }, ctx);

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
      // A submission id that was never created, so no terminal event can ever arrive for it.
      await trace.settled(999 as unknown as SubmissionId, 20);
      await trace.stop();
      await harness.close(ctx);

      expect(lines).toEqual(["trace: no settle event for submission 999 within 20ms"]);
    }));

  it("prefixes every line with the tag, so the runs of several cases stay distinguishable in one log", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      faux.setResponses([fauxAssistantMessage("hi")]);
      const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
      const { harness, root } = await openHarness(storage, { models, selection, registry: createBookingRuntime().registry }, ctx);

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx, { tag: "case-a#0" });
      const settled = await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      await trace.settled(settled.id);
      await trace.stop();
      await harness.close(ctx);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => line.startsWith("[case-a#0] "))).toBe(true);
    }));
});
