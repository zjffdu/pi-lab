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
import { createUpdateBookingStatusTool } from "./update-booking-status-tool.js";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, status, or containers.
  A booking can have several containers: name every one of them when asked, and never describe a
  booking as if it had only the first container you saw.
- update_booking_status changes a booking's status. Only call it when the user explicitly asks
  for a status change, and only for the booking they named. Call it once per requested change.
- Keep answers concise and state the booking number for every fact you report.`;

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

export const GET_BOOKING_TOOL_NAME = "get_booking";
export const UPDATE_BOOKING_STATUS_TOOL_NAME = "update_booking_status";

export type ReplayPolicy = "safe" | "unsafe";

export interface BookingRuntime {
  registry: ReturnType<typeof createRegistry>;
  repository: BookingRepository;
  /**
   * `toolName -> declared replay policy`, read off the same tool definitions the registry installs. The
   * telemetry bridge needs it because `tool_execution_start` carries a tool name and arguments but not the
   * tool's replay declaration.
   */
  toolReplayByName: ReadonlyMap<string, ReplayPolicy>;
}

/**
 * Tools and the system-prompt section reach the harness through a registry of named extensions this process
 * owns. Nothing in the registry is stored: a conversation stores only the extension names it selects. Both
 * tools are installed in one extension and always selected — unlike Lab 13 there is no governance gate.
 */
export function createBookingRuntime(repository = BookingRepository.fromDefaultFixture()): BookingRuntime {
  const tools = [createGetBookingTool(repository), createUpdateBookingStatusTool(repository)];
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools,
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  const toolReplayByName = new Map<string, ReplayPolicy>(tools.map((tool) => [tool.name, tool.replay ?? "unsafe"]));
  return { registry, repository, toolReplayByName };
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
  registry: BookingRuntime["registry"];
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation. Automatic
 * compaction is switched off so nothing summarizes behind an evaluation's back: every case's evidence is the
 * transcript it actually produced.
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
      registry: options.registry,
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
