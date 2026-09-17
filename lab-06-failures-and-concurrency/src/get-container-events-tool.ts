import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { ContainerEventRepository } from "./container-event-repository.js";

const getContainerEventsParameters = Type.Object(
  {
    containerNo: Type.String({
      description: "Exact container number returned by get_booking, for example MSKU1234567",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

interface GetContainerEventsDetails {
  containerNo: string;
  eventCount: number;
}

export class ContainerEventsNotFoundError extends Error {
  public constructor(containerNo: string) {
    super(`No container events found for: ${containerNo}`);
    this.name = "ContainerEventsNotFoundError";
  }
}

export function createGetContainerEventsTool(
  repository: ContainerEventRepository,
): AgentTool<typeof getContainerEventsParameters, GetContainerEventsDetails> {
  return {
    name: "get_container_events",
    label: "Get container events",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Requires the containerNo from get_booking. " +
      "Does not depend on get_port_status and may be requested in the same batch as it.",
    parameters: getContainerEventsParameters,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const events = repository.findByContainerNo(params.containerNo);
      if (events.length === 0) {
        throw new ContainerEventsNotFoundError(params.containerNo);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { containerNo: params.containerNo, eventCount: events.length },
      };
    },
  };
}
