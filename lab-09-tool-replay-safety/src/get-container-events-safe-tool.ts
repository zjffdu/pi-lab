import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { AttemptLog } from "./attempt-log.js";
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

export interface ToolDispatch {
  taskId: string;
  callId: string;
}

export interface GetContainerEventsSafeToolOptions {
  /** Read-only "slow work" duration. The failure injection kills the process well before
   * it elapses, so its exact value only matters for a run allowed to complete naturally. */
  delayMs: number;
  /** Fires the moment `execute()` starts, before the artificial delay: the checkpoint a
   * parent process waits for. Defaults to printing the shared marker line to stdout. */
  onDispatch?: (dispatch: ToolDispatch & { containerNo: string }) => void;
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
 * Read-only and declared `replay: "safe"`: the contrast case for `request-booking-hold-tool.ts`'s
 * `replay: "unsafe"`. When a process dies with this call's `pi.tool` task parked mid-flight, the
 * recovering harness does not synthesize an `interrupted` result the way it does for an unsafe
 * tool: it runs this `execute()` again, a second real invocation of the same logical call (same
 * task id, same call id; only one result is ever committed). That is safe here specifically
 * *because* looking up events twice has no effect on the world. Declaring `"safe"` on a tool
 * whose effect is not naturally idempotent would silently duplicate that effect instead:
 * `replay` is a promise the tool author makes, and Pi does not check it.
 */
export function createGetContainerEventsSafeTool(
  repository: ContainerEventRepository,
  attemptLog: AttemptLog,
  options: GetContainerEventsSafeToolOptions,
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
      "for one container, oldest first. Read-only. This call is intentionally slow, and " +
      "recovery from a restart may re-run it.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(args, api, context) {
      const taskId = String(api.taskId);
      attemptLog.recordSync({
        tool: "get_container_events",
        callId: api.callId,
        taskId,
        detail: args.containerNo,
        at: Date.now(),
      });
      onDispatch({ taskId, callId: api.callId, containerNo: args.containerNo });

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
