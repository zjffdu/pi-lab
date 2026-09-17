import {
  AgentHarness,
  type AgentLane,
  type Context,
  type OpenOperation,
  type Session,
} from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";

const SYSTEM_PROMPT = `You are a booking lookup assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a specific booking number.
- Use only facts returned by the tool or already established earlier in this same durable
  session. The session may span multiple processes; treat anything already in the
  transcript as established, whether or not you personally produced it.
- If the tool reports an error, clearly say that the booking could not be found.
- If the user refers to something (for example "it" or "that shipment") and no booking has
  been established yet in this session, ask which booking number they mean instead of
  guessing or calling a tool with an invented identifier.
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
    modelId: environment.PI_MODEL?.trim() || "deepseek-v4-flash",
  };
}

export interface OpenMainLaneResult {
  harness: AgentHarness;
  lane: AgentLane;
  /** Lanes with a durable operation left open when the harness attached to this session. */
  open: OpenOperation[];
}

/**
 * Attaches a fresh `AgentHarness` to an already-open `Session` and acquires its one
 * `main` lane. `AgentHarness.create()` restores every lane already recorded in the
 * session (branch tip, lane configuration, and any in-flight operation) before this
 * function returns — attaching a harness is not itself a durable write. `open` reports
 * any lane whose last operation was never driven to a terminal result; this lab's scope
 * never leaves one open (that is Lab 08), so it should always come back empty here.
 */
export async function openMainLane(
  session: Session,
  context: Context,
  selection = modelSelectionFromEnvironment(),
): Promise<OpenMainLaneResult> {
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
  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [createGetBookingTool(repository)],
      systemPrompt: SYSTEM_PROMPT,
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
