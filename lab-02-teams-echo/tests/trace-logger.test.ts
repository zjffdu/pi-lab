import { describe, expect, it } from "vitest";

import { createTraceLogger } from "../src/trace-logger.js";

describe("createTraceLogger", () => {
  it("makes the receive/reply lifecycle visible", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "activity_received", activityType: "message", conversationId: "conv-1", text: "hello" });
    log({ type: "reply_sent", conversationId: "conv-1", text: "you said: hello" });

    expect(lines).toEqual([
      '[Teams] activity_received type=message conversation=conv-1 text="hello"',
      '[Teams] reply_sent conversation=conv-1 text="you said: hello"',
    ]);
  });

  it("records handler errors without throwing", () => {
    const lines: string[] = [];
    const log = createTraceLogger((line) => lines.push(line));

    log({ type: "handler_error", conversationId: "conv-1", error: "network down" });

    expect(lines).toEqual(["[Teams] handler_error conversation=conv-1 error=network down"]);
  });
});
