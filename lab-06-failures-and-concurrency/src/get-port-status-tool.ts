import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PortStatusRepository } from "./port-status-repository.js";

const getPortStatusParameters = Type.Object(
  {
    portCode: Type.String({
      description: "Exact UN/LOCODE for the origin port returned by get_booking, for example CNSHA",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

interface GetPortStatusDetails {
  portCode: string;
}

export class PortStatusNotFoundError extends Error {
  public constructor(portCode: string) {
    super(`No port status found for: ${portCode}`);
    this.name = "PortStatusNotFoundError";
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export interface GetPortStatusToolOptions {
  /** Artificial delay, in milliseconds, before returning. Used to demonstrate parallel tool timing. */
  artificialDelayMs?: number;
}

export function createGetPortStatusTool(
  repository: PortStatusRepository,
  options: GetPortStatusToolOptions = {},
): AgentTool<typeof getPortStatusParameters, GetPortStatusDetails> {
  const artificialDelayMs = options.artificialDelayMs ?? 0;

  return {
    name: "get_port_status",
    label: "Get port status",
    description:
      "Report current congestion level and observation time for one port. Requires the " +
      "origin UN/LOCODE from get_booking. High congestion is a risk signal, not proof of a " +
      "specific delay cause. Does not depend on get_container_events and may be requested in " +
      "the same batch as it.",
    parameters: getPortStatusParameters,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      await delay(artificialDelayMs);
      signal?.throwIfAborted();

      const status = repository.findByPortCode(params.portCode);
      if (!status) {
        throw new PortStatusNotFoundError(params.portCode);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        details: { portCode: params.portCode },
      };
    },
  };
}
