import { describe, expect, it } from "vitest";

import { answerTurn, ctx, providerError, scriptedRuntime, toolCallTurn } from "./support/scripted-runtime.js";

// Entry and submission ids are one shared counter and token counts come from the scripted provider, so
// neither is stable. The trace *shape* is what these tests pin down.
function normalize(lines: string[]): string[] {
  return lines.map((line) =>
    line
      .replace(/entry=\d+/g, "entry=N")
      .replace(/inputs=\[\d+\]/g, "inputs=[N]")
      .replace(/tokens=\d+/g, "tokens=N")
      .replace(/ \d+ms\)/g, ")"),
  );
}

async function trace(
  steps: ReturnType<typeof answerTurn>[],
  prompt: string,
  options: Parameters<typeof scriptedRuntime>[0] = {},
  requestId = "req-1",
) {
  const lines: string[] = [];
  const h = await scriptedRuntime({ ...options, trace: (line) => lines.push(line) });
  h.respondWith(...steps);
  const result = await h.runtime.request(requestId, prompt);
  await h.runtime.close();
  return { lines: normalize(lines), result };
}

describe("harness trace logger", () => {
  it("renders prompt -> tool call -> result -> answer as a run/turn tree, with the call's arguments and the request id", async () => {
    const { lines } = await trace(
      [toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("BK1001 has two containers.")],
      "What are the details for BK1001?",
    );

    expect(lines).toEqual([
      '[req-1] user       "What are the details for BK1001?" entry=N',
      "[req-1] ▶ run inputs=[N]",
      "[req-1]   ▶ turn #1",
      "[req-1]     system     (prompt and tool changes) entry=N",
      '[req-1]     assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N (stop=toolUse tokens=N)',
      '[req-1]     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "[req-1]     ◀ tool_end get_booking call=call-1 status=success",
      "[req-1]     toolResult get_booking status=success entry=N",
      "[req-1]   ◀ turn_end #1 tool_results=1",
      "[req-1]   ▶ turn #2",
      "[req-1]     [Assistant] entry=N (stop=stop tokens=N) BK1001 has two containers.",
      "[req-1]   ◀ turn_end #2 tool_results=0",
      "[req-1] ◀ run_end inputs=[N]",
    ]);
  });

  it("draws a policy-blocked call as a refusal with its code and reason — there is no tool_start for it", async () => {
    const { lines } = await trace(
      [toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "cancelled" }, "call-1"), answerTurn("rejected")],
      "Cancel BK1001",
    );

    expect(lines.some((line) => line.includes("▶ tool_start"))).toBe(false);
    expect(lines).toContain(
      "[req-1]     ⊘ tool_refused update_booking_status call=call-1 code=blocked " +
        'reason="Tool call blocked: Cancellation is not permitted through update_booking_status in this lab; it always requires a separate process this tool does not model."',
    );
    expect(lines).toContain("[req-1]     toolResult update_booking_status status=error code=blocked entry=N");
  });

  it("tells apart the four ways a call can end in an error: refused (blocked, unavailable, invalid arguments) vs ran-and-threw", async () => {
    const blocked = await trace([toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "cancelled" }, "c"), answerTurn("x")], "go");
    const unavailable = await trace(
      [toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "c"), answerTurn("x")],
      "go",
      { offeredToolNames: ["get_booking"] },
    );
    const invalid = await trace([toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "teleported" }, "c"), answerTurn("x")], "go");
    const threw = await trace([toolCallTurn("get_booking", { bookingNo: "BK9999" }, "c"), answerTurn("x")], "go");

    const codeOf = (lines: string[], marker: string) => lines.find((line) => line.includes(marker))?.match(/code=(\w+)/)?.[1];
    expect(codeOf(blocked.lines, "⊘ tool_refused")).toBe("blocked");
    expect(codeOf(unavailable.lines, "⊘ tool_refused")).toBe("tool_unavailable");
    expect(codeOf(invalid.lines, "⊘ tool_refused")).toBe("invalid_arguments");
    // The only one that actually started the tool:
    expect(threw.lines.some((line) => line.includes("⊘ tool_refused"))).toBe(false);
    expect(codeOf(threw.lines, "◀ tool_end")).toBe("tool_error");
  });

  it("renders a provider failure as an error assistant line with the stop reason, and still closes the run", async () => {
    const { lines } = await trace([providerError()], "hi");

    expect(lines).toContain("[req-1]     assistant (error) provider exploded entry=N (stop=error tokens=N)");
    expect(lines.at(-1)).toBe("[req-1] ◀ run_end inputs=[N]");
  });

  it("labels each request's lines with that request's id, and prints no tag when no request is in flight", async () => {
    const lines: string[] = [];
    const h = await scriptedRuntime({ trace: (line) => lines.push(line) });
    h.respondWith(answerTurn("one"), answerTurn("two"), answerTurn("three"));

    await h.runtime.request("req-a", "first");
    await h.runtime.request("req-b", "second");
    // A submission that does not go through request(): no binding exists, so no invented tag.
    const settled = await (await h.runtime.root.submit({ type: "input", content: "direct" }, ctx)).wait(ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.runtime.close();

    expect(lines.filter((line) => line.startsWith("[req-a] ")).length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("[req-b] ")).length).toBeGreaterThan(0);
    expect(lines.find((line) => line.includes('"direct"'))).toMatch(/^user /); // untagged
    expect(settled.status).toBe("done");
  });
});
