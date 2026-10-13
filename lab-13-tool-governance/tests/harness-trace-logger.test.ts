import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { GOVERNED_TOOL_NAME } from "../src/governance-hooks.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { createFauxModels, recordingAuditLog, SpyBookingRepository, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

// Entry and submission ids are one shared counter, so they depend on how many records the harness wrote
// first. The trace shape is what these tests pin down, not the counter values.
function normalize(lines: string[]): string[] {
  return lines.map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"));
}

async function traceOneTurn(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  prompt: string,
  options: { offer: boolean; simulatePolicyBug?: boolean } = { offer: true },
) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(responses);

    const booking = createBookingRegistry({
      sessionId: "trace",
      auditLog: recordingAuditLog().auditLog,
      repository: new SpyBookingRepository(),
      simulatePolicyBug: options.simulatePolicyBug,
    });
    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openHarness(
      storage,
      { models, selection, booking, offerGovernedTool: options.offer },
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

const call = (name: string, args: Record<string, unknown>, id = "call-1") =>
  fauxToolCall(name, args as never, { id });

describe("harness trace logger", () => {
  it("renders prompt -> tool call -> tool result -> answer as a run/turn tree, request and execution on separate lines", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(call("get_booking", { bookingNo: "BK1001" }), { stopReason: "toolUse" }),
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
      "    ◀ tool_end get_booking call=call-1 status=success",
      "    toolResult get_booking status=success entry=N",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] entry=N final answer",
      "  ◀ turn_end #2 tool_results=0",
      "◀ run_end inputs=[N]",
    ]);
  });

  it("shows a blocked call as `⊘ tool_refused code=blocked` with the reason — there is no tool_start, because the tool never started", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(call(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "cancelled" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("rejected"),
      ],
      "Cancel BK1001.",
    );

    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=1") + 1);
    expect(turnOne).toEqual([
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      '    assistant (tool call) update_booking_status call=call-1 args={"bookingNo":"BK1001","newStatus":"cancelled"} entry=N',
      '    ⊘ tool_refused update_booking_status call=call-1 code=blocked reason="Tool call blocked: Cancellation is not permitted through update_booking_status in this lab; it always requires a separate process this tool does not model."',
      "    toolResult update_booking_status status=error code=blocked entry=N",
      "  ◀ turn_end #1 tool_results=1",
    ]);
    expect(lines.some((line) => line.includes("▶ tool_start update_booking_status"))).toBe(false);
  });

  it("tells a tool that is not offered apart from one that was blocked: same status=error, different code", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(call(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "in_transit" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("not available"),
      ],
      "Mark BK1001 in transit.",
      { offer: false },
    );

    expect(lines).toContain(
      '    ⊘ tool_refused update_booking_status call=call-1 code=tool_unavailable reason="Tool update_booking_status is not available"',
    );
    expect(lines).toContain("    toolResult update_booking_status status=error code=tool_unavailable entry=N");
  });

  it("shows a tool that ran and threw as a normal start/end pair with code=tool_error — not as a refusal", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(call(GOVERNED_TOOL_NAME, { bookingNo: "BK9999", newStatus: "in_transit" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("no such booking"),
      ],
      "Mark BK9999 in transit.",
    );

    expect(lines).toContain(
      '    ▶ tool_start update_booking_status call=call-1 args={"bookingNo":"BK9999","newStatus":"in_transit"}',
    );
    expect(lines).toContain("    ◀ tool_end update_booking_status call=call-1 status=error code=tool_error");
    expect(lines.some((line) => line.includes("tool_refused"))).toBe(false);
  });

  it("prints a policy bug as a refusal whose reason is the thrown message", async () => {
    const { lines } = await traceOneTurn(
      [
        fauxAssistantMessage(call(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "in_transit" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("failed"),
      ],
      "Mark BK1001 in transit.",
      { offer: true, simulatePolicyBug: true },
    );

    expect(lines).toContain(
      '    ⊘ tool_refused update_booking_status call=call-1 code=blocked reason="Tool call blocked: Simulated bug in the beforeTool policy hook (not a deliberate decline)."',
    );
  });

  // One assistant message can carry preamble text and several tool-call requests. The trace prints the
  // text and one line per requested call, so the model's request is never hidden behind its prose, and
  // each `call=` id pairs a request with the line that records what the harness did about it.
  it("prints preamble text and every requested call separately, and pairs each with its own outcome by call id", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(
          [
            fauxText("Checking, then changing."),
            call("get_booking", { bookingNo: "BK1001" }, "call-1"),
            call(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "cancelled" }, "call-2"),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "Look up BK1001 and cancel it.",
    );

    expect(settled.status).toBe("done");
    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=2") + 1);
    expect(turnOne).toEqual([
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      "    [Assistant] entry=N Checking, then changing.",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N',
      '    assistant (tool call) update_booking_status call=call-2 args={"bookingNo":"BK1001","newStatus":"cancelled"} entry=N',
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking call=call-1 status=success",
      "    toolResult get_booking status=success entry=N",
      expect.stringMatching(/^ {4}⊘ tool_refused update_booking_status call=call-2 code=blocked reason="Tool call blocked: Cancellation/),
      "    toolResult update_booking_status status=error code=blocked entry=N",
      "  ◀ turn_end #1 tool_results=2",
    ]);
  });
});
