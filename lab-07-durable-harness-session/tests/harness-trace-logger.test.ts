import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { createBookingRegistry, openRootConversation } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { createFauxModels, SpyBookingRepository, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

// Entry and submission ids are one shared counter, so they depend on how many records the
// harness wrote first. The trace shape is what these tests pin down, not the counter values.
function normalize(lines: string[]): string[] {
  return lines.map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"));
}

async function traceOneTurn(responses: ReturnType<typeof fauxAssistantMessage>[], prompt: string) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(responses);

    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openRootConversation(
      storage,
      { models, selection, registry: createBookingRegistry(new SpyBookingRepository()) },
      ctx,
    );

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
  it("renders prompt -> tool call -> tool result -> answer as a run/turn tree", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), {
          stopReason: "toolUse",
        }),
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
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N',
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success entry=N",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] entry=N final answer",
      "  ◀ turn_end #2 tool_results=0",
      "◀ run_end inputs=[N]",
    ]);
  });

  // One assistant message can carry preamble text and several tool-call requests. The trace prints the
  // text and one line per requested call, so the model's request is never hidden behind its prose, and
  // each `call=` id pairs a request with the tool_start/tool_end that executed it.
  it("prints preamble text and every requested tool call as separate lines", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(
          [
            fauxText("Let me check both bookings."),
            fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }),
            fauxToolCall("get_booking", { bookingNo: "BAD_ID" }, { id: "call-2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "Compare BK1001 and BAD_ID.",
    );

    expect(settled.status).toBe("done");
    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=2") + 1);
    expect(turnOne).toEqual([
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      "    [Assistant] entry=N Let me check both bookings.",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N',
      '    assistant (tool call) get_booking call=call-2 args={"bookingNo":"BAD_ID"} entry=N',
      // `get_booking` is a sequential tool, so each call runs and commits its own result before the next starts.
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success entry=N",
      '    ▶ tool_start get_booking call=call-2 args={"bookingNo":"BAD_ID"}',
      "    ◀ tool_end get_booking status=error",
      "    toolResult get_booking status=error entry=N",
      "  ◀ turn_end #1 tool_results=2",
    ]);
  });

  it("shows an unknown booking as a tool error that still reaches a second turn", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BAD_ID" }, { id: "call-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("The booking could not be found."),
      ],
      "What are the details for booking BAD_ID?",
    );

    expect(settled.status).toBe("done");
    expect(lines).toContain("    ◀ tool_end get_booking status=error");
    expect(lines).toContain("    toolResult get_booking status=error entry=N");
    expect(lines).toContain("  ▶ turn #2");
  });

  // `stop()` only promises to stop future callbacks, so the CLI and these tests wait on `settled()`
  // instead. It must not hang forever if the terminal event never shows up.
  it("writes a visible warning instead of hanging when a submission never settles", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
      const { harness, root } = await openRootConversation(
        storage,
        { models, selection, registry: createBookingRegistry(new SpyBookingRepository()) },
        ctx,
      );

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
      // A submission id that was never created, so no terminal event can ever arrive for it.
      await trace.settled(999 as unknown as SubmissionId, 20);
      await trace.stop();
      await harness.close(ctx);

      expect(lines).toEqual(["trace: no settle event for submission 999 within 20ms"]);
    }));

  it("shows a provider failure on the assistant line", async () => {
    const { lines, settled } = await traceOneTurn(
      [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })],
      "What are the details for booking BK1001?",
    );

    expect(settled.status).toBe("unanswered");
    expect(lines).toContain("    assistant (error) 401 invalid api key entry=N");
  });
});
