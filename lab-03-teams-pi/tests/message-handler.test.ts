import { describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRunner, AgentRunResult } from "../src/agent-runner.js";
import { deriveReply } from "../src/message-handler.js";
import type { TeamsTraceEvent } from "../src/teams-trace-logger.js";

class FakeAgentRunner implements AgentRunner {
  public lastInput?: AgentRunInput;

  public constructor(private readonly result: AgentRunResult) {}

  public async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.lastInput = input;
    return this.result;
  }
}

describe("deriveReply", () => {
  it("traces the inbound activity, then delegates the text to the runner", async () => {
    const runner = new FakeAgentRunner({ answer: "BK1001 ships MSKU1234567 from CNSHA." });
    const events: TeamsTraceEvent[] = [];

    const answer = await deriveReply(runner, (event) => events.push(event), {
      activityType: "message",
      conversationId: "conv-1",
      text: "What are the details for BK1001?",
      requestId: "req-1",
    });

    expect(answer).toBe("BK1001 ships MSKU1234567 from CNSHA.");
    expect(runner.lastInput).toEqual({
      text: "What are the details for BK1001?",
      requestId: "req-1",
    });
    expect(events).toEqual([
      {
        type: "activity_received",
        activityType: "message",
        conversationId: "conv-1",
        requestId: "req-1",
        text: "What are the details for BK1001?",
      },
    ]);
  });

  it("passes through a bounded fallback answer without treating it as a transport error", async () => {
    const fallback = "Sorry, I could not reach the assistant service for this request. Please try again in a moment.";
    const runner = new FakeAgentRunner({ answer: fallback });

    const answer = await deriveReply(runner, () => {}, {
      activityType: "message",
      conversationId: "conv-2",
      text: "anything",
      requestId: "req-2",
    });

    expect(answer).toBe(fallback);
  });
});
