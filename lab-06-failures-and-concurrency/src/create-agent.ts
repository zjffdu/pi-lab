import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createGetContainerEventsTool } from "./get-container-events-tool.js";
import { createGetPortStatusTool } from "./get-port-status-tool.js";
import { PortStatusRepository } from "./port-status-repository.js";

const SYSTEM_PROMPT = `You are a shipment investigation assistant in a learning lab.

Tool sequence:
- Call get_booking first. A booking can have several containers, so it returns containerNos (a list) and origin.
- get_container_events takes one container at a time: call it once for each container in containerNos.
  Those calls and get_port_status depend only on the get_booking result, not on each other,
  so request all of them in the same assistant turn.

Evidence rules:
- Use only facts returned by the tools. Never invent a booking, container number, port code, or event.
- If a tool reports an error (booking, container events, or port status not found), say plainly
  what is missing instead of guessing or filling the gap.
- A LOAD event later than the booking's plannedDeparture is evidence of a departure delay for that container.
  Assess every container separately and say which containers show it; never generalize one container's
  events to the whole booking.
- A high port congestion level is an additional risk signal, observed at its own timestamp.
- Congestion is correlational, not a proven cause. Never state that congestion caused a delay.
- Structure a full investigation answer in three parts: observed delay evidence, risk signal, and
  what the evidence does not establish.
- If an extra request arrives after your first answer in the same conversation, treat it as a
  genuine follow-up and answer it directly using what is already known; do not repeat tool calls
  for facts you already have.
- Keep every answer concise.`;

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

export interface ResilienceAgentOptions {
  /**
   * Artificial delay, in milliseconds, before get_port_status returns.
   * Widens the window in which a steer() or followUp() call can land while
   * the tool is still running (Experiments B and C).
   */
  portStatusDelayMs?: number;
}

export function createResilienceAgent(
  selection = modelSelectionFromEnvironment(),
  options: ResilienceAgentOptions = {},
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

  const bookingRepository = BookingRepository.fromDefaultFixture();
  const containerEventRepository = ContainerEventRepository.fromDefaultFixture();
  const portStatusRepository = PortStatusRepository.fromDefaultFixture();

  return new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [
        createGetBookingTool(bookingRepository),
        createGetContainerEventsTool(containerEventRepository),
        createGetPortStatusTool(portStatusRepository, {
          artificialDelayMs: options.portStatusDelayMs ?? 0,
        }),
      ],
    },
    streamFn: streamFn ?? models.streamSimple.bind(models),
    toolExecution: "parallel",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  });
}
