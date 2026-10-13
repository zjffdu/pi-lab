import { describe, expect, it } from "vitest";

import { createPiAgentRunner, INFRASTRUCTURE_ERROR_ANSWER } from "../src/agent-runner.js";
import { modelSelectionFromEnvironment } from "../src/create-agent.js";
import { assistant, scriptedStream, toolCallThenAnswer } from "./scripted-stream.js";

const SELECTION = modelSelectionFromEnvironment({});

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("createPiAgentRunner", () => {
  it("returns a bounded infrastructure answer instead of throwing when the model cannot be resolved", async () => {
    const { lines, write } = collect();
    const runner = createPiAgentRunner(
      { provider: "not-a-real-provider", modelId: "not-a-real-model" },
      write,
    );

    const result = await runner.run({
      text: "What are the details for BK1001?",
      requestId: "req-test-1",
    });

    expect(result).toEqual({ answer: INFRASTRUCTURE_ERROR_ANSWER });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Pi\]\[req:req-test-1\] setup_error /);
  });
});

// These drive the real Pi Agent through the runner with a scripted stream function, so the
// runner's three outcomes are checked against the pinned Pi release without a live model.
describe("createPiAgentRunner against the pinned Pi release", () => {
  it("returns the final assistant text and tags the whole Pi trace with the request ID", async () => {
    const { lines, write } = collect();
    const runner = createPiAgentRunner(
      SELECTION,
      write,
      scriptedStream(toolCallThenAnswer("BK1001", "BK1001 ships MSKU1234567 from CNSHA.")),
    );

    const result = await runner.run({ text: "What are the details for BK1001?", requestId: "req-1" });

    expect(result).toEqual({ answer: "BK1001 ships MSKU1234567 from CNSHA." });
    expect(lines.every((line) => line.startsWith("[Pi][req:req-1] "))).toBe(true);
    expect(lines.map((line) => line.replace("[Pi][req:req-1] ", ""))).toEqual([
      "▶ agent",
      "  ▶ turn #1",
      '    user       "What are the details for BK1001?"',
      "    assistant (tool calls: get_booking)",
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] BK1001 ships MSKU1234567 from CNSHA.",
      "  ◀ turn_end #2 tool_results=0",
      "◀ agent_end",
    ]);
  });

  it("passes a tool error through as the model's not-found answer, not as an infrastructure failure", async () => {
    const { lines, write } = collect();
    const runner = createPiAgentRunner(
      SELECTION,
      write,
      scriptedStream(toolCallThenAnswer("BAD_ID", "I could not find booking BAD_ID.")),
    );

    const result = await runner.run({ text: "What are the details for BAD_ID?", requestId: "req-2" });

    expect(result).toEqual({ answer: "I could not find booking BAD_ID." });
    expect(result.answer).not.toBe(INFRASTRUCTURE_ERROR_ANSWER);
    expect(lines.some((line) => line.endsWith("◀ tool_end get_booking status=error"))).toBe(true);
    expect(lines.some((line) => line.includes("provider_error"))).toBe(false);
  });

  it("catches a provider failure inside the runner and returns the infrastructure answer", async () => {
    const { lines, write } = collect();
    const runner = createPiAgentRunner(
      SELECTION,
      write,
      scriptedStream([assistant({ stopReason: "error", errorMessage: "401 invalid api key", content: [] })]),
    );

    const result = await runner.run({ text: "What are the details for BK1001?", requestId: "req-3" });

    expect(result).toEqual({ answer: INFRASTRUCTURE_ERROR_ANSWER });
    expect(lines).toContain("[Pi][req:req-3] provider_error 401 invalid api key");
  });
});
