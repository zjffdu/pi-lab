import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CompactionPolicy,
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
- Call get_booking before making any claim about a booking's route, vessel, dates, containers,
  or hold status. A booking can have several containers: call get_container_events once per
  container before making any claim about movement, and never generalize one container's
  events to the whole booking. Both tools are read-only.
- Use only facts returned by a tool, a compacted summary, or already established earlier in
  this same durable session. The conversation may have been compacted; treat anything in the
  transcript, including a summary of earlier history, as established fact.
- If you are not sure whether an earlier fact survived compaction, say so plainly instead of
  guessing or inventing a value.
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

function nonNegativeIntFromEnvironment(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * This lab compacts only when it says so: `enabled: false` turns off the threshold and overflow
 * triggers (a manual `compact()` ignores `enabled`), and `backgroundTokens: 0` turns off the
 * background trigger, so nothing summarizes behind the experiment's back. The two budgets are
 * far smaller than pi-durable's own defaults (`reserveTokens: 16384`, `keepRecentTokens: 20000`)
 * so a short seeded conversation actually has an old prefix to cut. `reserveTokens` is also the
 * summary's output budget (`0.8 * reserveTokens`), and 1.1 fails the compaction task when a summary
 * hits that limit instead of keeping the truncated text — a first run with `300` (240 summary
 * tokens) and a second with `1000` (800) both did exactly that against a live model, hence `2000`.
 */
export function compactionPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Partial<CompactionPolicy> {
  return {
    enabled: false,
    backgroundTokens: 0,
    reserveTokens: nonNegativeIntFromEnvironment(environment, "COMPACT_RESERVE_TOKENS", 2000),
    keepRecentTokens: nonNegativeIntFromEnvironment(environment, "COMPACT_KEEP_RECENT_TOKENS", 180),
  };
}

/**
 * Tools and system-prompt sections reach the harness through a registry of named extensions that
 * this process owns. Nothing in the registry is stored: a conversation stores only the extension
 * names it selects, so the code must be installed again in every process that reopens the session.
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

export interface OpenedConversation {
  harness: Harness;
  root: Conversation;
  /** Unfinished tasks and unsettled submissions found when the harness attached (Lab 08's topic). */
  inspection: HarnessInspection;
}

export interface OpenRootOptions {
  models: Models;
  selection?: ModelSelection;
  registry?: ReturnType<typeof createBookingRegistry>;
  compaction?: Partial<CompactionPolicy>;
}

/** Attaches a fresh `Harness` to an already-open storage and returns its root conversation. */
export async function openRootConversation(
  storage: Storage,
  options: OpenRootOptions,
  context: Context,
): Promise<OpenedConversation> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry ?? createBookingRegistry(),
      settings: { compaction: options.compaction ?? compactionPolicyFromEnvironment() },
    },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: { model: { provider: selection.provider, modelId: selection.modelId } },
  });
  return { harness, root, inspection };
}
