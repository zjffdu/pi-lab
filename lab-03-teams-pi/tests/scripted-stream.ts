import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistant(
  partial: Pick<AssistantMessage, "content" | "stopReason"> & { errorMessage?: string },
): AssistantMessage {
  return { role: "assistant", api: "scripted", provider: "deepseek", model: "scripted", usage: USAGE, timestamp: 0, ...partial };
}

// Replays scripted assistant messages, one per LLM call, through the real Agent loop.
export function scriptedStream(script: AssistantMessage[]): StreamFn {
  let calls = 0;
  return () => {
    const message = script[calls];
    calls += 1;
    if (!message) throw new Error("scripted stream ran out of messages");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
    });
    return stream;
  };
}

export function toolCallThenAnswer(bookingNo: string, answer: string): AssistantMessage[] {
  return [
    assistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "get_booking", arguments: { bookingNo } }],
    }),
    assistant({ stopReason: "stop", content: [{ type: "text", text: answer }] }),
  ];
}
