import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { formatCheckpoint } from "./checkpoint.js";
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

export interface SlowContainerEventsToolOptions {
  /** Read-only "slow work" duration. This lab's failure injection kills the process well
   * before this delay elapses, so its exact value only matters for a run that is allowed
   * to complete naturally. */
  delayMs: number;
  /** Fires the moment execute() starts, before the artificial delay — this is the
   * checkpoint a parent process waits for. Defaults to printing the shared marker format
   * to stdout, which is what `scripts/crash-recovery-demo.ts` watches for. */
  onDispatch?: (toolCallId: string, containerNo: string) => void;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Same shape as Lab 04's `get_container_events`, but intentionally slow and instrumented:
 * it announces the moment it starts (the checkpoint) before doing any of its artificial
 * "work". By the time `execute()` runs at all, the assistant message carrying this tool
 * call is already a durable entry — invoking a tool is never the thing that makes a
 * tool-call durable, the harness recording the assistant's decision is. This tool exists
 * to give a human-controlled window between "durable" and "outcome committed" for Lab 08
 * to kill the process inside.
 */
export function createSlowContainerEventsTool(
  repository: ContainerEventRepository,
  options: SlowContainerEventsToolOptions,
): AgentHarnessTool<undefined, typeof getContainerEventsParameters, GetContainerEventsDetails> {
  const onDispatch =
    options.onDispatch ??
    ((toolCallId: string, containerNo: string) => {
      console.log(formatCheckpoint({ name: "tool_dispatched", toolCallId, tool: "get_container_events", containerNo }));
    });

  return {
    name: "get_container_events",
    label: "Get container events (slow)",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Read-only. This call is intentionally slow.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
      onDispatch(toolCallId, params.containerNo);

      await delay(options.delayMs, context.abortSignal);

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
