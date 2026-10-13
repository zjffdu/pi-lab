import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { CaseFixture } from "./case-registry.js";
import type { RunResult } from "./pipeline.js";

export function latestAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    if (text) return text;
  }
  return undefined;
}

export function parseScore(text: string): number | undefined {
  const match = /SCORE:\s*([0-3])/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function buildJudgePrompt(kase: CaseFixture, result: RunResult): string | undefined {
  if (!kase.semantic) return undefined;
  return [
    `Rubric: ${kase.semantic.rubric}`,
    kase.semantic.mustMention ? `Must mention: ${kase.semantic.mustMention.join(", ")}` : "",
    kase.semantic.mustNotMention ? `Must not mention: ${kase.semantic.mustNotMention.join(", ")}` : "",
    `Answer to score: """${result.answer}"""`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface LiveJudgement {
  liveScore: number | undefined;
  rawResponse: string;
  /** Present when the provider failed; a failed call is never read as a score of 0. */
  errorMessage?: string;
}

/** One live scoring call. The caller owns the agent, so it can subscribe a trace logger first. */
export async function judgeWithAgent(agent: Agent, prompt: string): Promise<LiveJudgement> {
  await agent.prompt(prompt);
  if (agent.state.errorMessage) return { liveScore: undefined, rawResponse: "", errorMessage: agent.state.errorMessage };
  const rawResponse = latestAssistantText(agent.state.messages) ?? "";
  return { liveScore: parseScore(rawResponse), rawResponse };
}
