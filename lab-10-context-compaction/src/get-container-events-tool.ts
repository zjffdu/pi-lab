import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

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

export class ContainerEventsNotFoundError extends Error {
  public constructor(containerNo: string) {
    super(`No container events found for: ${containerNo}`);
    this.name = "ContainerEventsNotFoundError";
  }
}

/** Read-only, no artificial delay: this lab needs durable tool-result entries, not slow work. */
export function createGetContainerEventsTool(repository: ContainerEventRepository) {
  return defineTool({
    name: "get_container_events",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Read-only.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    async execute(args) {
      const events = repository.findByContainerNo(args.containerNo);
      if (events.length === 0) {
        throw new ContainerEventsNotFoundError(args.containerNo);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { containerNo: args.containerNo, eventCount: events.length },
      };
    },
  });
}
