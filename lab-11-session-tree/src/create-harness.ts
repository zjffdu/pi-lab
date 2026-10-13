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
import { createGetContainerEventsTool } from "./get-container-events-tool.js";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, dates, or containers.
  A booking can have several containers: call get_container_events once per container before
  making any claim about movement, and never generalize one container's events to the whole
  booking. Both tools are read-only.
- Use only what is in the transcript in front of you right now: this conversation's own history
  and tool results. A conversation can be a fork of an earlier one and share its history up to the
  fork point; nothing that happened after that point in a different conversation is visible to you.
- If a booking or fact was not established earlier in what you can currently see, say so plainly
  instead of guessing or inventing a value.
- Keep answers concise.`;

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

/**
 * Tools and system-prompt sections reach the harness through a registry of named extensions that
 * this process owns. Nothing in the registry is stored: a conversation stores only the extension
 * names it selects, so the code must be installed again in every process that reopens the session —
 * including for a fork, which selects the same extensions its parent had at the fork entry.
 */
export function createBookingRegistry(
  bookings = BookingRepository.fromDefaultFixture(),
  containerEvents = ContainerEventRepository.fromDefaultFixture(),
) {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [createGetBookingTool(bookings), createGetContainerEventsTool(containerEvents)],
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  return registry;
}

export interface OpenedHarness {
  harness: Harness;
  root: Conversation;
  /** Unfinished tasks and unsettled submissions found when the harness attached (Lab 08's topic). */
  inspection: HarnessInspection;
}

export interface OpenHarnessOptions {
  models: Models;
  selection?: ModelSelection;
  registry?: ReturnType<typeof createBookingRegistry>;
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation. Every
 * other conversation of the session — the forks — is reached through `harness.conversation(id)` or
 * `harness.scanConversations()`, not through this function.
 *
 * Automatic compaction is switched off so nothing summarizes behind the experiment's back: this lab
 * is about which entries a branch inherits, not about what the model is allowed to forget.
 */
export async function openHarness(
  storage: Storage,
  options: OpenHarnessOptions,
  context: Context,
): Promise<OpenedHarness> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry ?? createBookingRegistry(),
      settings: { compaction: { enabled: false, backgroundTokens: 0 } },
    },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: { model: { provider: selection.provider, modelId: selection.modelId } },
  });
  return { harness, root, inspection };
}
