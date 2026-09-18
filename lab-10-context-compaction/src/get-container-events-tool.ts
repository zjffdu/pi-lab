import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { ContainerEventRepository } from "./container-event-repository.js";

const getContainerEventsParameters = Type.Object(
  {
    containerNo: Type.String({
      description: "Exact container number, for example MSKU1234567",
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

/**
 * Read-only, declared `replay: "safe"`. Unlike Lab 09's version of this tool, there is no
 * artificial delay here — this lab is not exercising crash recovery, so the tool only needs
 * to produce a real, durable tool-result entry that later becomes "tool evidence" for the
 * compaction cut point to summarize or retain.
 */
export function createGetContainerEventsTool(
  repository: ContainerEventRepository,
): AgentHarnessTool<undefined, typeof getContainerEventsParameters, GetContainerEventsDetails> {
  return {
    name: "get_container_events",
    label: "Get container events",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Read-only.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(_toolCallId, params) {
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
