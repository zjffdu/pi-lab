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
import { createSlowContainerEventsTool } from "./slow-container-events-tool.js";

const SYSTEM_PROMPT = `You are a booking and shipment lookup assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a specific booking number.
- Call get_container_events before making any claim about a container's movement history.
  You do not need to call get_booking first if the user already gave you the exact
  container number directly.
- get_container_events is read-only and intentionally slow; that is expected, not an error.
- Use only facts returned by a tool or already established earlier in this same durable
  session. The session may span multiple processes; treat anything already in the
  transcript as established, whether or not you personally produced it.
- If a tool reports an error, clearly say the requested record could not be found.
- If the user refers to something (for example "it" or "that shipment") and no booking or
  container has been established yet in this session, ask which one they mean instead of
  guessing or calling a tool with an invented identifier.
- Do not infer delay risk, causes, or operational status beyond what the tools return.
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

/** Default artificial delay for `get_container_events`. Overridable so the crash-recovery
 * demo script can dial it however long it needs without touching source. */
export function slowToolDelayMsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.SLOW_TOOL_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8000;
}

export interface OpenMainLaneResult {
  harness: AgentHarness;
  lane: AgentLane;
  /** Lanes with a durable operation left open when the harness attached to this session. */
  open: OpenOperation[];
}

export interface OpenMainLaneOptions {
  selection?: ModelSelection;
  slowToolDelayMs?: number;
  onSlowToolDispatch?: (toolCallId: string, containerNo: string) => void;
}

/**
 * Same attach contract as Lab 07's `openMainLane`: `AgentHarness.create()` restores every
 * lane already recorded in the session (branch tip, lane configuration, and any in-flight
 * operation) before returning. Lab 08 extends Lab 07's single `get_booking` tool with one
 * more, `get_container_events`, whose slowness is the point — it is Lab 08's fixture for
 * "the operation is durable but the tool outcome is not yet committed."
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
  const slowToolDelayMs = options.slowToolDelayMs ?? slowToolDelayMsFromEnvironment();

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [
        createGetBookingTool(bookingRepository),
        createSlowContainerEventsTool(containerEventRepository, {
          delayMs: slowToolDelayMs,
          onDispatch: options.onSlowToolDispatch,
        }),
      ],
      systemPrompt: SYSTEM_PROMPT,
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
