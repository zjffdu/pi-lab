import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createTraceLogger } from "../src/agent-trace-logger.js";
import { loadCases } from "../src/case-registry.js";
import { createJudgeAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { buildJudgePrompt, judgeWithAgent, parseScore } from "../src/live-judge.js";
import { runCase } from "../src/runner.js";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function scripted(message: Omit<AssistantMessage, "role" | "api" | "provider" | "model" | "usage" | "timestamp">): { streamFn: StreamFn; prompts: unknown[] } {
  const prompts: unknown[] = [];
  const full: AssistantMessage = { role: "assistant", api: "scripted", provider: "deepseek", model: "scripted", usage: USAGE, timestamp: 0, ...message };
  const streamFn: StreamFn = (_model, context) => {
    prompts.push(context);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: full.stopReason as "stop", message: full });
      stream.end(full);
    });
    return stream;
  };
  return { streamFn, prompts };
}

function caseWithRubric() {
  const kase = loadCases("dev").find((entry) => entry.semantic !== undefined);
  if (!kase) throw new Error("fixture missing");
  return { kase, result: runCase(kase).record.result };
}

describe("live judge on the Pi 1.1 Agent (scripted provider, no network)", () => {
  it("scores through the real Agent loop and traces the turn", async () => {
    const { kase, result } = caseWithRubric();
    const { streamFn, prompts } = scripted({ stopReason: "stop", content: [{ type: "text", text: "SCORE: 3" }] });
    const agent = createJudgeAgent(modelSelectionFromEnvironment({}), streamFn);
    const lines: string[] = [];
    agent.subscribe(createTraceLogger((line) => lines.push(line)));

    const judged = await judgeWithAgent(agent, buildJudgePrompt(kase, result) ?? "");

    expect(judged).toEqual({ liveScore: 3, rawResponse: "SCORE: 3" });
    expect(prompts).toHaveLength(1);
    expect(lines).toContain("  ▶ turn #1");
    expect(lines).toContain("    [Assistant] SCORE: 3");
  });

  it("reports a provider failure as an error, never as a score of 0", async () => {
    const { streamFn } = scripted({ stopReason: "error", errorMessage: "401 invalid api key", content: [] });
    const agent = createJudgeAgent(modelSelectionFromEnvironment({}), streamFn);
    const judged = await judgeWithAgent(agent, "prompt");
    expect(judged.liveScore).toBeUndefined();
    expect(judged.errorMessage).toBe("401 invalid api key");
  });

  it("treats an unparseable reply as an unavailable score", async () => {
    const { streamFn } = scripted({ stopReason: "stop", content: [{ type: "text", text: "I think it is fine." }] });
    const judged = await judgeWithAgent(createJudgeAgent(modelSelectionFromEnvironment({}), streamFn), "prompt");
    expect(judged.liveScore).toBeUndefined();
  });

  it("parses only 0-3 scores and builds a prompt only for cases that declare a rubric", () => {
    expect(parseScore("SCORE: 2")).toBe(2);
    expect(parseScore("SCORE: 7")).toBeUndefined();
    const withoutRubric = loadCases("dev").find((entry) => entry.semantic === undefined);
    if (!withoutRubric) throw new Error("fixture missing");
    expect(buildJudgePrompt(withoutRubric, runCase(withoutRubric).record.result)).toBeUndefined();
  });

  it("defaults to the Pi 1.1 model id", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
  });
});
