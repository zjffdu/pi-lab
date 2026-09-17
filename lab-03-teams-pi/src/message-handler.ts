import type { AgentRunner } from "./agent-runner.js";
import type { TeamsTraceEvent } from "./teams-trace-logger.js";

export interface InboundMessage {
  activityType: string;
  conversationId: string;
  text: string;
  requestId: string;
}

export type Trace = (event: TeamsTraceEvent) => void;

/**
 * The delegation half of the thin Teams handler: trace the inbound activity,
 * hand its text to the AgentRunner, and return the answer to send back.
 * Kept free of the real Teams SDK context so it can be tested with a fake
 * AgentRunner instead of a live Playground round trip.
 */
export async function deriveReply(
  runner: AgentRunner,
  trace: Trace,
  message: InboundMessage,
): Promise<string> {
  trace({
    type: "activity_received",
    activityType: message.activityType,
    conversationId: message.conversationId,
    requestId: message.requestId,
    text: message.text,
  });

  const { answer } = await runner.run({ text: message.text, requestId: message.requestId });
  return answer;
}
