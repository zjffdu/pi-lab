import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

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

export class ContainerEventsNotFoundError extends Error {
  public constructor(containerNo: string) {
    super(`No container events found for: ${containerNo}`);
    this.name = "ContainerEventsNotFoundError";
  }
}

export interface SlowContainerEventsToolOptions {
  /** Read-only "slow work" duration. This lab's failure injection kills the process well
   * before it elapses, so its exact value only matters for a run allowed to finish. */
  delayMs: number;
  /** Fires the moment `execute()` starts, before the artificial delay: the checkpoint a
   * parent process waits for. Defaults to printing the shared marker line to stdout. */
  onDispatch?: (dispatch: { taskId: string; callId: string; containerNo: string }) => void;
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
 * Same shape as Lab 04's `get_container_events`, but intentionally slow and instrumented. It
 * announces itself before doing any of its artificial "work". By the time `execute()` runs at
 * all, the harness has already committed this call's intent as a durable `pi.tool` task, so the
 * checkpoint fires in the window the lab needs: the call is durable, its result is not.
 *
 * `replay` is deliberately left at its default (`"unsafe"`): an interrupted call is not rerun on
 * recovery, the model receives an `interrupted` error result instead. Declaring it `"safe"`, and
 * seeing what changes, is Lab 09's question.
 */
export function createSlowContainerEventsTool(
  repository: ContainerEventRepository,
  options: SlowContainerEventsToolOptions,
) {
  const onDispatch =
    options.onDispatch ??
    (({ taskId, callId, containerNo }) => {
      console.log(formatCheckpoint({ name: "tool_dispatched", tool: "get_container_events", taskId, callId, containerNo }));
    });

  return defineTool({
    name: "get_container_events",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Read-only. This call is intentionally slow.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    async execute(args, api, context) {
      onDispatch({ taskId: String(api.taskId), callId: api.callId, containerNo: args.containerNo });

      await delay(options.delayMs, context.abortSignal);

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
