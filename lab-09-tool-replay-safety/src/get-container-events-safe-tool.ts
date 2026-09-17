import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

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

export interface GetContainerEventsSafeToolOptions {
  /** Read-only "slow work" duration. The failure injection kills the process well before
   * this delay elapses, so its exact value only matters for a run allowed to complete
   * naturally. */
  delayMs: number;
  /** Fires the moment execute() starts, before the artificial delay — the checkpoint a
   * parent process waits for. Defaults to printing the shared marker format to stdout. */
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
 * Read-only and declared `replay: "safe"` — the recovery contrast case for
 * `request-booking-hold-tool.ts`'s `replay: "never"`. When a process dies with this call
 * parked mid-flight, `lane.resume()` does not synthesize an interrupted result the way it
 * does for a `"never"` tool: it clears the call's durable checkpoint and calls this
 * `execute()` again, a second real invocation of the exact same logical call (same
 * `invocationId`, same `toolCallId` — only one commits a durable result). That is safe here
 * specifically *because* looking up events twice has no effect on the world; declaring
 * `replay: "safe"` on a tool whose effect is not naturally idempotent would silently
 * duplicate that effect instead.
 */
export function createGetContainerEventsSafeTool(
  repository: ContainerEventRepository,
  attemptLog: AttemptLog,
  options: GetContainerEventsSafeToolOptions,
): AgentHarnessTool<undefined, typeof getContainerEventsParameters, GetContainerEventsDetails> {
  const onDispatch =
    options.onDispatch ??
    ((toolCallId: string, containerNo: string) => {
      console.log(
        formatCheckpoint({ name: "tool_dispatched", toolCallId, tool: "get_container_events", containerNo }),
      );
    });

  return {
    name: "get_container_events",
    label: "Get container events (safe replay)",
    description:
      "List the timestamped movement events (GATE_IN, LOAD, DEPARTURE, DISCHARGE, GATE_OUT) " +
      "for one container, oldest first. Read-only. This call is intentionally slow, and " +
      "recovery from a restart may re-run it.",
    parameters: getContainerEventsParameters,
    executionMode: "sequential",
    replay: "safe",
    async execute(toolCallId, params, _onUpdate, _toolContext, invocation, context) {
      attemptLog.recordSync({
        tool: "get_container_events",
        toolCallId,
        invocationId: invocation.invocationId,
        detail: params.containerNo,
        at: Date.now(),
      });
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
