import { describe, expect, it } from "vitest";

import { createPiAgentRunner, INFRASTRUCTURE_ERROR_ANSWER } from "../src/agent-runner.js";

describe("createPiAgentRunner", () => {
  it("returns a bounded infrastructure answer instead of throwing when the model cannot be resolved", async () => {
    const lines: string[] = [];
    const runner = createPiAgentRunner(
      { provider: "not-a-real-provider", modelId: "not-a-real-model" },
      (line) => lines.push(line),
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
