import type { SessionRegistry } from "./session-registry.js";

export type MessageDelivery = "prompted" | "queued-as-follow-up";

export interface MessageDeliveryResult {
  /** Which path this message took. */
  delivery: MessageDelivery;
  /** Resolves once the run this message belongs to has fully settled. */
  settled: Promise<void>;
}

/**
 * This lab's explicit policy for a second message arriving while the same
 * conversation's agent is already running: it is queued with
 * `agent.followUp()`, never started as a second concurrent `prompt()` call,
 * and never dropped or rejected. Pi only injects a queued follow-up once the
 * current run has no more tool calls and no pending steering messages, so a
 * conversation's tool-result messages stay single and in order no matter how
 * many messages arrive while it is busy.
 *
 * The first (non-busy) message for a conversation starts the run and its
 * `prompt()` promise is remembered so that a later, busy-time call can hand
 * back a promise that resolves only once that whole run — including any
 * follow-ups queued into it — has settled.
 */
export function createConcurrentMessagePolicy(registry: SessionRegistry): {
  sendMessage(conversationId: string, text: string): MessageDeliveryResult;
} {
  const activeRuns = new Map<string, Promise<void>>();

  return {
    sendMessage(conversationId, text) {
      const agent = registry.getOrCreate(conversationId);

      if (agent.state.isStreaming) {
        agent.followUp({ role: "user", content: text, timestamp: Date.now() });
        return {
          delivery: "queued-as-follow-up",
          settled: activeRuns.get(conversationId) ?? Promise.resolve(),
        };
      }

      const settled = agent.prompt(text);
      activeRuns.set(conversationId, settled);
      return { delivery: "prompted", settled };
    },
  };
}
