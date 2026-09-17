import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * Selects the in-memory Pi transcript for a conversation identity.
 *
 * The registry is a plain `Map` living in this process's heap. It has no
 * disk or database backing, so a process restart always starts from an
 * empty registry, even when a caller reuses the exact same conversation id.
 */
export interface SessionRegistry {
  /** Returns the existing agent for this conversation id, or creates and stores a new one. */
  getOrCreate(conversationId: string): Agent;
  /** True when this conversation id already has a live agent in this process. */
  has(conversationId: string): boolean;
  /** Number of distinct conversations currently tracked. */
  size(): number;
  /** Drops every tracked conversation, simulating loss of all in-memory state. */
  reset(): void;
}

export function createSessionRegistry(createAgent: () => Agent): SessionRegistry {
  const agents = new Map<string, Agent>();

  return {
    getOrCreate(conversationId) {
      const existing = agents.get(conversationId);
      if (existing) {
        return existing;
      }

      const agent = createAgent();
      agents.set(conversationId, agent);
      return agent;
    },
    has(conversationId) {
      return agents.has(conversationId);
    },
    size() {
      return agents.size;
    },
    reset() {
      agents.clear();
    },
  };
}
