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

import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createSlowContainerEventsTool, type SlowContainerEventsToolOptions } from "./slow-container-events-tool.js";

export const SYSTEM_PROMPT = `You are a booking and shipment lookup assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a specific booking number. A booking can
  have several containers; report all of them, never assume there is only one.
- Call get_container_events before making any claim about one container's movement history.
  You do not need to call get_booking first if the user already gave you the exact
  container number directly.
- get_container_events is read-only and intentionally slow; that is expected, not an error.
- Use only facts returned by a tool or already established earlier in this same durable
  session. The session may span multiple processes; treat anything already in the
  transcript as established, whether or not you personally produced it.
- If a tool reports an error, clearly say the requested record could not be found. If a tool
  result says the call was interrupted, say that the lookup did not complete; do not guess
  its result.
- If the user refers to something (for example "it" or "that shipment") and no booking or
  container has been established yet in this session, ask which one they mean instead of
  guessing or calling a tool with an invented identifier.
- Do not infer delay risk, causes, or operational status beyond what the tools return.
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

/** Default artificial delay for `get_container_events`; the demo script dials it via the environment. */
export function slowToolDelayMsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.SLOW_TOOL_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8000;
}

export interface BookingRegistryOptions {
  bookings?: BookingRepository;
  containerEvents?: ContainerEventRepository;
  slowTool?: Partial<SlowContainerEventsToolOptions>;
}

/**
 * Tools and system-prompt sections reach the harness through a registry of named extensions
 * that this process owns. Nothing in the registry is stored. By default a conversation follows
 * whatever extensions the process installed, and it records extension *names* only when some are
 * selected explicitly, so the code must be installed again in every process that reopens the
 * session. That is what makes recovery possible at all: the reopened process re-installs the same
 * tools, and the harness finds the interrupted call's tool by name.
 */
export function createBookingRegistry(options: BookingRegistryOptions = {}) {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [
        createGetBookingTool(options.bookings ?? BookingRepository.fromDefaultFixture()),
        createSlowContainerEventsTool(options.containerEvents ?? ContainerEventRepository.fromDefaultFixture(), {
          delayMs: options.slowTool?.delayMs ?? slowToolDelayMsFromEnvironment(),
          onDispatch: options.slowTool?.onDispatch,
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
   * Lab 07 never left anything behind. This lab does: after a killed process it is non-empty.
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
  options: { models: Models; selection?: ModelSelection; registry?: ReturnType<typeof createBookingRegistry> },
  context: Context,
): Promise<OpenedConversation> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);

  const harness = await Harness.open(
    storage,
    { models: options.models, registry: options.registry ?? createBookingRegistry() },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: { model: { provider: selection.provider, modelId: selection.modelId } },
  });
  return { harness, root, inspection };
}
