import {
  AgentHarness,
  type AgentLane,
  type Context,
  type OpenOperation,
  type Session,
} from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fileURLToPath } from "node:url";

import { AttemptLog } from "./attempt-log.js";
import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import { createGetContainerEventsSafeTool } from "./get-container-events-safe-tool.js";
import { OutboxRepository } from "./outbox-repository.js";
import { createRequestBookingHoldTool } from "./request-booking-hold-tool.js";

const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_container_events before making any claim about a container's movement history.
  It is read-only and intentionally slow; if the process ever restarts mid-call, recovery
  may safely re-run it, and that is expected, not an error.
- Call request_booking_hold only when the user explicitly asks you to place an operational
  hold on one specific booking number, and only after you have a clear reason for the hold.
  It is state-changing. If the process ever restarts mid-call, do not call it again for the
  same request — say plainly that the outcome is unknown instead of guessing or retrying.
- Use only facts returned by a tool or already established earlier in this same durable
  session. The session may span multiple processes; treat anything already in the
  transcript as established, whether or not you personally produced it.
- If a tool reports an error, or reports that its execution was interrupted, say so clearly
  instead of inventing an outcome.
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

function delayMsFromEnvironment(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Default artificial delay for the safe `get_container_events` tool. Overridable so the
 * replay-safety demo script can dial it however long it needs without touching source. */
export function safeToolDelayMsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  return delayMsFromEnvironment(environment, "SAFE_TOOL_DELAY_MS", 8000);
}

/** Default artificial post-effect delay for `request_booking_hold`, after its outbox
 * append is already durable. */
export function holdToolDelayMsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  return delayMsFromEnvironment(environment, "HOLD_TOOL_DELAY_MS", 8000);
}

const DEFAULT_EVIDENCE_ROOT = fileURLToPath(new URL("../runtime-evidence", import.meta.url));

export function attemptLogPathFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ATTEMPT_LOG_PATH?.trim() || `${DEFAULT_EVIDENCE_ROOT}/attempts.jsonl`;
}

export function outboxPathFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OUTBOX_PATH?.trim() || `${DEFAULT_EVIDENCE_ROOT}/outbox.jsonl`;
}

export interface OpenMainLaneResult {
  harness: AgentHarness;
  lane: AgentLane;
  /** Lanes with a durable operation left open when the harness attached to this session. */
  open: OpenOperation[];
}

export interface OpenMainLaneOptions {
  selection?: ModelSelection;
  safeToolDelayMs?: number;
  holdToolDelayMs?: number;
  attemptLogPath?: string;
  outboxPath?: string;
  onSafeToolDispatch?: (toolCallId: string, containerNo: string) => void;
  onHoldToolDispatch?: (toolCallId: string, bookingNo: string) => void;
  onHoldEffectAppended?: (toolCallId: string, bookingNo: string, holdId: string) => void;
}

/**
 * Same attach contract as Lab 07/08's `openMainLane`: `AgentHarness.create()` restores
 * every lane already recorded in the session (branch tip, lane configuration, and any
 * in-flight operation) before returning. Lab 09 registers Lab 08's fast `get_booking`
 * tool's read-only sibling (`get_container_events`, now declared `replay: "safe"`) next to
 * one brand-new state-changing tool (`request_booking_hold`, declared `replay: "never"`)
 * so the same crash-recovery mechanics can be directly contrasted between the two
 * policies.
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
  const attemptLog = new AttemptLog(options.attemptLogPath ?? attemptLogPathFromEnvironment());
  const outbox = new OutboxRepository(options.outboxPath ?? outboxPathFromEnvironment());
  const safeToolDelayMs = options.safeToolDelayMs ?? safeToolDelayMsFromEnvironment();
  const holdToolDelayMs = options.holdToolDelayMs ?? holdToolDelayMsFromEnvironment();

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [
        createGetContainerEventsSafeTool(containerEventRepository, attemptLog, {
          delayMs: safeToolDelayMs,
          onDispatch: options.onSafeToolDispatch,
        }),
        createRequestBookingHoldTool(bookingRepository, outbox, attemptLog, {
          delayMs: holdToolDelayMs,
          onDispatch: options.onHoldToolDispatch,
          onEffectAppended: options.onHoldEffectAppended,
        }),
      ],
      systemPrompt: SYSTEM_PROMPT,
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
