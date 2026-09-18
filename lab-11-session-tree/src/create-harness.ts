import {
  AgentHarness,
  type AgentLane,
  type Context,
  type OpenOperation,
  type Session,
} from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createGetContainerEventsTool } from "./get-container-events-tool.js";

const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route or vessel. Call
  get_container_events before making any claim about a container's movement history. Both are
  read-only.
- This session's history may have been rearranged by navigating back to an earlier point and
  continuing from there. Use only what is actually in front of you right now: the current
  transcript, any "conversation history before this point was summarized" block, and tool
  results. Do not assume a fact from a different conversation you are not shown still applies.
- If a booking or fact was not established earlier in what you can currently see, say so plainly
  instead of guessing or inventing a value.
- Keep answers concise.`;

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

export interface OpenMainLaneOptions {
  selection?: ModelSelection;
}

/**
 * Same attach contract as Labs 07-10's `openMainLane`: `AgentHarness.create()` restores every
 * lane already recorded in the session before returning. This lab registers the same two
 * read-only tools Lab 10 uses (`get_booking`, `get_container_events`) and does not touch
 * compaction settings — the harness's own large default (`keepRecentTokens: 20000`) never
 * triggers on this lab's short seeded conversations, so nothing here competes with the tree
 * navigation this lab is actually about.
 */
export async function openMainLane(
  session: Session,
  context: Context,
  options: OpenMainLaneOptions = {},
): Promise<OpenMainLaneResult> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
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

  const bookingRepository = BookingRepository.fromDefaultFixture();
  const containerEventRepository = ContainerEventRepository.fromDefaultFixture();

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [createGetBookingTool(bookingRepository), createGetContainerEventsTool(containerEventRepository)],
      systemPrompt: SYSTEM_PROMPT,
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
