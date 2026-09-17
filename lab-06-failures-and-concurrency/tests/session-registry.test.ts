import type { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createSessionRegistry } from "../src/session-registry.js";

function fakeAgentFactory(): { createAgent: () => Agent; calls: number[] } {
  const calls: number[] = [];
  const createAgent = (): Agent => {
    calls.push(calls.length);
    return { id: calls.length } as unknown as Agent;
  };
  return { createAgent, calls };
}

describe("createSessionRegistry", () => {
  it("returns the same agent instance for repeated lookups of one conversation id", () => {
    const { createAgent, calls } = fakeAgentFactory();
    const registry = createSessionRegistry(createAgent);

    const first = registry.getOrCreate("conversation-a");
    const second = registry.getOrCreate("conversation-a");

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("isolates different conversation ids behind distinct agent instances", () => {
    const { createAgent } = fakeAgentFactory();
    const registry = createSessionRegistry(createAgent);

    const a = registry.getOrCreate("conversation-a");
    const b = registry.getOrCreate("conversation-b");

    expect(a).not.toBe(b);
    expect(registry.size()).toBe(2);
  });

  it("reports whether a conversation id already has a live agent", () => {
    const { createAgent } = fakeAgentFactory();
    const registry = createSessionRegistry(createAgent);

    expect(registry.has("conversation-a")).toBe(false);
    registry.getOrCreate("conversation-a");
    expect(registry.has("conversation-a")).toBe(true);
  });

  it("drops every tracked conversation on reset, forcing a fresh agent afterward", () => {
    const { createAgent, calls } = fakeAgentFactory();
    const registry = createSessionRegistry(createAgent);

    const before = registry.getOrCreate("conversation-a");
    registry.reset();

    expect(registry.size()).toBe(0);
    expect(registry.has("conversation-a")).toBe(false);

    const after = registry.getOrCreate("conversation-a");
    expect(after).not.toBe(before);
    expect(calls).toHaveLength(2);
  });
});
