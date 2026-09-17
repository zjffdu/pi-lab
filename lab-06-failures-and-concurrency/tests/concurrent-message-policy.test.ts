import type { Agent, AgentMessage, AgentState } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

import { createConcurrentMessagePolicy } from "../src/concurrent-message-policy.js";
import { createSessionRegistry } from "../src/session-registry.js";

/**
 * A fake agent whose `prompt()` does not resolve until the test calls
 * `finishRun()`, so a second `sendMessage` can be issued while the agent is
 * still "streaming" — the exact condition Lab 06's concurrency policy has to
 * handle.
 */
function createFakeAgent(): {
  agent: Agent;
  promptCalls: string[];
  followUpCalls: AgentMessage[];
  finishRun: () => void;
} {
  let streaming = false;
  const promptCalls: string[] = [];
  const followUpCalls: AgentMessage[] = [];
  let finishRun: () => void = () => {};

  const agent = {
    get state(): AgentState {
      return { isStreaming: streaming } as AgentState;
    },
    prompt: vi.fn((text: string) => {
      promptCalls.push(text);
      streaming = true;
      return new Promise<void>((resolve) => {
        finishRun = () => {
          streaming = false;
          resolve();
        };
      });
    }),
    followUp: vi.fn((message: AgentMessage) => {
      followUpCalls.push(message);
    }),
  } as unknown as Agent;

  return {
    agent,
    promptCalls,
    followUpCalls,
    finishRun: () => finishRun(),
  };
}

describe("createConcurrentMessagePolicy", () => {
  it("starts an idle conversation with prompt()", () => {
    const fake = createFakeAgent();
    const registry = createSessionRegistry(() => fake.agent);
    const policy = createConcurrentMessagePolicy(registry);

    const result = policy.sendMessage("conversation-a", "What are the details for BK1001?");

    expect(result.delivery).toBe("prompted");
    expect(fake.promptCalls).toEqual(["What are the details for BK1001?"]);
    expect(fake.followUpCalls).toHaveLength(0);
  });

  it("queues a second message as a follow-up instead of starting a concurrent prompt()", async () => {
    const fake = createFakeAgent();
    const registry = createSessionRegistry(() => fake.agent);
    const policy = createConcurrentMessagePolicy(registry);

    const first = policy.sendMessage("conversation-a", "Investigate BK1001.");
    const second = policy.sendMessage("conversation-a", "Also check the port congestion.");

    expect(second.delivery).toBe("queued-as-follow-up");
    expect(fake.promptCalls).toEqual(["Investigate BK1001."]);
    expect(fake.followUpCalls).toHaveLength(1);
    const queued = fake.followUpCalls[0];
    expect(queued?.role).toBe("user");
    expect(queued && queued.role === "user" ? queued.content : undefined).toBe(
      "Also check the port congestion.",
    );

    let firstSettled = false;
    let secondSettled = false;
    void first.settled.then(() => {
      firstSettled = true;
    });
    void second.settled.then(() => {
      secondSettled = true;
    });

    // Both promises stay pending until the original run finishes.
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    fake.finishRun();
    await first.settled;
    await second.settled;

    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
  });

  it("starts a fresh prompt() once the conversation is idle again", () => {
    const fake = createFakeAgent();
    const registry = createSessionRegistry(() => fake.agent);
    const policy = createConcurrentMessagePolicy(registry);

    policy.sendMessage("conversation-a", "Investigate BK1001.");
    fake.finishRun();

    const afterIdle = policy.sendMessage("conversation-a", "Which container is it using?");

    expect(afterIdle.delivery).toBe("prompted");
    expect(fake.promptCalls).toEqual(["Investigate BK1001.", "Which container is it using?"]);
  });
});
