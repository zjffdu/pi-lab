import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";

import { assertModelAvailable, type ModelSelection } from "./create-harness.js";
import { BACKGROUND_CONTEXT } from "./session-store.js";

const JUDGE_SYSTEM_PROMPT = `You are a strict grading assistant. You will be shown a user request and an
assistant's answer to it. Rate the answer's helpfulness and clarity from 1 (unhelpful or
confusing) to 5 (clear, complete, and directly responsive), given only the request and answer —
you have no other context and cannot verify factual claims yourself.

Respond with ONLY a single JSON object, no other text: {"score": <integer 1-5>, "rationale": "<one sentence>"}`;

export interface SemanticJudgment {
  caseId: string;
  repetition: number;
  score: number | undefined;
  rationale: string;
  judgeProvider: string;
  judgeModelId: string;
  raw: string;
}

export interface JudgeAnswerOptions {
  caseId: string;
  repetition: number;
  prompt: string;
  answerText: string;
  models: Models;
  selection: ModelSelection;
  context?: Context;
}

export function judgeSelectionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelSelection {
  return {
    provider: environment.PI_JUDGE_PROVIDER?.trim() || environment.PI_PROVIDER?.trim() || "deepseek",
    modelId: environment.PI_JUDGE_MODEL?.trim() || environment.PI_MODEL?.trim() || "deepseek-flash",
  };
}

export function parseJudgment(raw: string): { score: number | undefined; rationale: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { score: undefined, rationale: `Could not locate a JSON object in judge output: ${raw}` };
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null) return { score: undefined, rationale: "Judge output was not a JSON object." };
    const candidate = parsed as Record<string, unknown>;
    const score =
      typeof candidate.score === "number" && Number.isInteger(candidate.score) && candidate.score >= 1 && candidate.score <= 5
        ? candidate.score
        : undefined;
    const rationale = typeof candidate.rationale === "string" ? candidate.rationale : "Judge output had no string 'rationale' field.";
    return { score, rationale };
  } catch {
    return { score: undefined, rationale: `Judge output was not valid JSON: ${raw}` };
  }
}

/**
 * The "semantic answer quality" lane the roadmap asks to keep separate from deterministic invariants
 * (`deterministic-checks.ts`). It is one isolated, tool-free model call through `models.completeSimple` — no
 * `Harness`, no session, no telemetry capture — so a judge call can never leave entries or spans in the
 * evidence it is grading. It never feeds into or overrides a deterministic check: a polished answer that
 * fails `identifier-provenance` still fails it regardless of the score this judge gives it.
 */
export async function judgeAnswer(options: JudgeAnswerOptions): Promise<SemanticJudgment> {
  assertModelAvailable(options.models, options.selection);
  const model = options.models.getModel(options.selection.provider, options.selection.modelId);
  if (!model) {
    throw new Error(`Unknown judge model ${options.selection.provider}/${options.selection.modelId}`);
  }

  const reply = await options.models.completeSimple(model, {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Request:\n${options.prompt}\n\nAnswer:\n${options.answerText || "(empty answer)"}`,
        timestamp: Date.now(),
      },
    ],
  });

  const raw = reply.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
  const { score, rationale } = parseJudgment(raw);
  return {
    caseId: options.caseId,
    repetition: options.repetition,
    score,
    rationale,
    judgeProvider: options.selection.provider,
    judgeModelId: options.selection.modelId,
    raw,
  };
}

export { BACKGROUND_CONTEXT };
