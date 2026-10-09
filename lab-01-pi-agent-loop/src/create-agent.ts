import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";

const SYSTEM_PROMPT = `You are a booking lookup assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking.
- Use only facts returned by the tool.
- If the tool reports an error, state what the tool reported and do not claim anything about the booking beyond that.
- Do not infer delay risk, causes, or operational status; this lab only contains booking master data.
- Keep the final answer concise.`;

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export function modelSelectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelSelection {
  return {
    provider: environment.PI_PROVIDER?.trim() || "deepseek",
    modelId: environment.PI_MODEL?.trim() || "deepseek-flash",
  };
}

export function createBookingAgent(
  selection = modelSelectionFromEnvironment(),
  streamFn?: StreamFn,
): Agent {
  const models = builtinModels();
  const model = models.getModel(selection.provider, selection.modelId);

  if (!model) {
    const available = models
      .getModels(selection.provider)
      .map((candidate) => candidate.id)
      .slice(0, 12)
      .join(", ");
    throw new Error(
      `Unknown model ${selection.provider}/${selection.modelId}. ` +
        `Available model ids include: ${available || "none"}`,
    );
  }

  const repository = BookingRepository.fromDefaultFixture();
  return new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [createGetBookingTool(repository)],
    },
    streamFn: streamFn ?? models.streamSimple.bind(models),
    toolExecution: "sequential",
  });
}
