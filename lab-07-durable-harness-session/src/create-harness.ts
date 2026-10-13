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

export const SYSTEM_PROMPT = `You are a booking lookup assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a specific booking number.
- Use only facts returned by the tool or already established earlier in this same durable
  session. The session may span multiple processes; treat anything already in the
  transcript as established, whether or not you personally produced it.
- If the tool reports an error, clearly say that the booking could not be found.
- If the user refers to something (for example "it" or "that shipment") and no booking has
  been established yet in this session, ask which booking number they mean instead of
  guessing or calling a tool with an invented identifier.
- Do not infer delay risk, causes, or operational status; this lab only contains booking master data.
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

/**
 * Tools and system-prompt sections reach the harness through a registry of named extensions
 * that this process owns. Nothing in the registry is stored. By default a conversation follows
 * whatever extensions the process installed, and it records extension *names* only when some are
 * selected explicitly, so the code must be installed again in every process that reopens the session.
 */
export function createBookingRegistry(repository = BookingRepository.fromDefaultFixture()) {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [createGetBookingTool(repository)],
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
   * This lab's scope never leaves anything behind (that is Lab 08), so it should always be empty.
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
