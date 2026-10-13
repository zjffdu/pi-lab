import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * A model to stand in for the roadmap's "bounded live evaluation" layer: it scores one case's
 * answer against its rubric and returns a single number. It is deliberately not wired into
 * `npm run check`, `npm run evaluate`, or `release-gate.ts`'s default path — only
 * `scripts/evaluate-live.ts` constructs it, and only when explicitly invoked.
 */
const SYSTEM_PROMPT = `You are a calibration judge in a learning lab. You are given a rubric and an
answer the pipeline produced. Reply with a single line: "SCORE: <integer 0-3>" where 0 means the
answer violates the rubric and 3 means it fully satisfies it. Do not explain your reasoning.`;

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export function modelSelectionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelSelection {
  return {
    provider: environment.PI_PROVIDER?.trim() || "deepseek",
    modelId: environment.PI_MODEL?.trim() || "deepseek-flash",
  };
}

export function createJudgeAgent(selection = modelSelectionFromEnvironment(), streamFn?: StreamFn): Agent {
  const models = builtinModels();
  const model = models.getModel(selection.provider, selection.modelId);
  if (!model) {
    const available = models.getModels(selection.provider).map((candidate) => candidate.id).slice(0, 12).join(", ");
    throw new Error(`Unknown model ${selection.provider}/${selection.modelId}. Available model ids include: ${available || "none"}`);
  }
  return new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: [] },
    streamFn: streamFn ?? models.streamSimple.bind(models),
    toolExecution: "sequential",
  });
}
