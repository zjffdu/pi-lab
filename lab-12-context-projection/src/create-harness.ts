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
import { createGetBookingTool } from "./get-booking-tool.js";
import type { ProviderBoundary } from "./provider-boundary.js";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, dates, or containers.
  A booking can have several containers; never generalize one container to the whole booking.
  The tool is read-only.
- Some of what you are told may come from an internal case-management note written into this
  conversation for you, not from get_booking. Treat it exactly like any other message you can see:
  use it, but never invent detail beyond what you were actually shown.
- If asked about something you were never shown, including anything you were not given permission
  to see, say plainly that you do not have that information. Do not guess or reconstruct it.
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
 * Tools, system-prompt sections, and the provider-boundary hook reach the harness through a registry of
 * named extensions that this process owns. Nothing in the registry is stored: the code must be installed
 * again in every process that reopens the session.
 */
export function createBookingRegistry(
  options: { bookings?: BookingRepository; boundary?: ProviderBoundary } = {},
) {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [createGetBookingTool(options.bookings ?? BookingRepository.fromDefaultFixture())],
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  if (options.boundary) {
    registry.install(options.boundary.extension);
  }
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
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation.
 *
 * Automatic compaction is switched off so nothing rewrites context behind the experiment's back: this lab
 * is about which entries contribute to a request, not about what the model is allowed to forget. It also
 * keeps the provider boundary honest, since `beforeRequest` does not cover a compaction's own requests.
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
