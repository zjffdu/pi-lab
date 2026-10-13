import { fileURLToPath } from "node:url";

import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  type HarnessInspection,
  section,
  type Storage,
} from "@earendil-works/pi-durable";

import { AttemptLog } from "./attempt-log.js";
import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import {
  createGetContainerEventsSafeTool,
  type GetContainerEventsSafeToolOptions,
} from "./get-container-events-safe-tool.js";
import { OutboxRepository } from "./outbox-repository.js";
import { createRequestBookingHoldTool, type RequestBookingHoldToolOptions } from "./request-booking-hold-tool.js";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_container_events before making any claim about a container's movement history.
  It is read-only and intentionally slow; if the process ever restarts mid-call, recovery
  may safely re-run it, and that is expected, not an error.
- When the user explicitly asks you to place an operational hold on one specific booking
  number and gives a reason, call request_booking_hold with that booking number and that
  reason right away; the user's stated reason is enough, and you do not need any other
  lookup first. It is state-changing. If the process ever restarts mid-call, do not call it
  again for the same request: say plainly that the outcome is unknown instead of guessing
  or retrying.
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
    modelId: environment.PI_MODEL?.trim() || "deepseek-flash",
  };
}

/** Fails at startup with the catalog's real ids, instead of failing inside the first model request. */
export function assertModelAvailable(models: Models, selection: ModelSelection): void {
  if (models.getModel(selection.provider, selection.modelId)) {
    return;
  }

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

function delayMsFromEnvironment(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Default artificial delay for the safe `get_container_events` tool; the demo dials it via the environment. */
export function safeToolDelayMsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  return delayMsFromEnvironment(environment, "SAFE_TOOL_DELAY_MS", 8000);
}

/** Default artificial post-effect delay for `request_booking_hold`, after its outbox append is already durable. */
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

export interface ReplayRegistryOptions {
  bookings?: BookingRepository;
  containerEvents?: ContainerEventRepository;
  attemptLog?: AttemptLog;
  outbox?: OutboxRepository;
  safeTool?: Partial<GetContainerEventsSafeToolOptions>;
  holdTool?: Partial<RequestBookingHoldToolOptions>;
}

/**
 * Tools and system-prompt sections reach the harness through a registry of named extensions that
 * this process owns. Nothing in the registry is stored: the process that reopens a crashed session
 * installs the same tools again, and the harness finds the interrupted call's tool by name. The
 * tool's `replay` declaration lives in that code, which is why it applies to a call a *previous*
 * process started. Lab 09 installs two tools that differ in exactly that declaration:
 * `get_container_events` (`"safe"`, read-only) and `request_booking_hold` (`"unsafe"`, appends to a
 * local outbox).
 */
export function createReplayRegistry(options: ReplayRegistryOptions = {}) {
  const attemptLog = options.attemptLog ?? new AttemptLog(attemptLogPathFromEnvironment());
  const outbox = options.outbox ?? new OutboxRepository(outboxPathFromEnvironment());

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "replay-safety",
      tools: [
        createGetContainerEventsSafeTool(options.containerEvents ?? ContainerEventRepository.fromDefaultFixture(), attemptLog, {
          delayMs: options.safeTool?.delayMs ?? safeToolDelayMsFromEnvironment(),
          onDispatch: options.safeTool?.onDispatch,
        }),
        createRequestBookingHoldTool(options.bookings ?? BookingRepository.fromDefaultFixture(), outbox, attemptLog, {
          delayMs: options.holdTool?.delayMs ?? holdToolDelayMsFromEnvironment(),
          onDispatch: options.holdTool?.onDispatch,
          onEffectAppended: options.holdTool?.onEffectAppended,
          replay: options.holdTool?.replay,
        }),
      ],
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  return registry;
}

export interface OpenedConversation {
  harness: Harness;
  root: Conversation;
  /**
   * Unfinished tasks and unsettled submissions found when the harness attached. `inspect()` writes
   * nothing and runs no task code, so it is a safe look at what the previous process left behind.
   * Lab 07 never left anything behind; after a killed process this is non-empty (Lab 08).
   */
  inspection: HarnessInspection;
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation.
 * `Harness.open()` and `root()` rebuild all runtime state from what the storage holds; the
 * storage, not the harness, is what survives a restart. `root()` creates the conversation with
 * the given model on first use and returns the stored one afterwards.
 */
export async function openRootConversation(
  storage: Storage,
  options: { models: Models; selection?: ModelSelection; registry?: ReturnType<typeof createReplayRegistry> },
  context: Context,
): Promise<OpenedConversation> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);

  const harness = await Harness.open(
    storage,
    { models: options.models, registry: options.registry ?? createReplayRegistry() },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: { model: { provider: selection.provider, modelId: selection.modelId } },
  });
  return { harness, root, inspection };
}
