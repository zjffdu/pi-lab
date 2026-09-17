import { describe, expect, it } from "vitest";

import { createTeamsTraceLogger } from "../src/teams-trace-logger.js";

describe("createTeamsTraceLogger", () => {
  it("tags every line with the request ID that ties it to a Pi run", () => {
    const lines: string[] = [];
    const log = createTeamsTraceLogger((line) => lines.push(line));

    log({
      type: "activity_received",
      activityType: "message",
      conversationId: "conv-1",
      requestId: "req-1",
      text: "BK1001?",
    });
    log({ type: "reply_sent", conversationId: "conv-1", requestId: "req-1", text: "answer" });

    expect(lines).toEqual([
      '[Teams][req:req-1] activity_received type=message conversation=conv-1 text="BK1001?"',
      '[Teams][req:req-1] reply_sent conversation=conv-1 text="answer"',
    ]);
  });

  it("records handler errors without throwing", () => {
    const lines: string[] = [];
    const log = createTeamsTraceLogger((line) => lines.push(line));

    log({ type: "handler_error", conversationId: "conv-1", requestId: "req-2", error: "network down" });

    expect(lines).toEqual(["[Teams][req:req-2] handler_error conversation=conv-1 error=network down"]);
  });
});
