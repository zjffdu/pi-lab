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

import type { AuditLog } from "./audit-log.js";
import { BookingRepository } from "./booking-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createGovernanceExtension, GOVERNED_TOOL_NAME } from "./governance-hooks.js";

export { GOVERNED_TOOL_NAME };
export const READ_ONLY_TOOL_NAME = "get_booking";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, status, or containers.
  A booking can have several containers; a status belongs to the booking as a whole. Read-only.
- update_booking_status, when it is offered to you, changes a booking's status. Some requested
  changes will be rejected by the system regardless of why you were asked to make them — if that
  happens, tell the user plainly that the change was rejected and why, using exactly the reason you
  were given. Do not retry a rejected change with different wording.
- If update_booking_status is not offered to you as a tool at all, say so plainly instead of
  attempting a workaround.
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

export interface BookingRegistryOptions {
  /** The application's own session id; written into every audit record. */
  sessionId: string;
  /** Required, with no silent default: where governance decisions go is this lab's whole point. */
  auditLog: AuditLog;
  repository?: BookingRepository;
  /** Forwarded to the governance extension. Demo/test-only. */
  simulatePolicyBug?: boolean;
}

/**
 * Two extensions, two jobs. `booking` carries the prompt and the read-only `get_booking`.
 * `booking-governance` carries `update_booking_status` *and* the hooks that guard it, so the tool
 * cannot be installed without its guard. Nothing here is stored: a conversation stores only the names
 * of the extensions and tools it selects, so this code must be installed again in every process that
 * reopens the session.
 */
export function createBookingRegistry(options: BookingRegistryOptions) {
  const repository = options.repository ?? BookingRepository.fromDefaultFixture();
  const getBookingTool = createGetBookingTool(repository);
  const governance = createGovernanceExtension({
    sessionId: options.sessionId,
    auditLog: options.auditLog,
    repository,
    simulatePolicyBug: options.simulatePolicyBug,
  });

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [getBookingTool],
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  registry.install(governance.extension);

  return {
    registry,
    repository,
    tools: { getBooking: getBookingTool, updateBookingStatus: governance.updateBookingStatusTool },
  };
}

export type BookingRegistry = ReturnType<typeof createBookingRegistry>;

export interface OpenedHarness {
  harness: Harness;
  root: Conversation;
  /** Unfinished tasks and unsettled submissions found when the harness attached (Lab 08's topic). */
  inspection: HarnessInspection;
}

export interface OpenHarnessOptions {
  models: Models;
  selection?: ModelSelection;
  booking: BookingRegistry;
  /**
   * `true` makes sure `update_booking_status` is among the tools the root conversation offers.
   * Leaving it out never *removes* an offered tool: which tools a conversation offers is stored in its
   * `pi.agent` document, so it survives a restart, and a later process that does not pass the flag
   * inherits whatever the session already offers.
   */
  offerGovernedTool?: boolean;
  /**
   * Receives every hook failure the harness swallowed instead of failing the call — for this lab, an
   * `afterTool` audit write that threw. `HarnessOptions.onReport` defaults to a no-op, which would make
   * that failure completely silent; this lab prints it to stderr unless a caller (a test) collects it.
   */
  onReport?: (error: unknown) => void;
}

/** The tool names a conversation's next model request will offer, in order. */
export async function offeredToolNames(conversation: Conversation, context: Context): Promise<string[]> {
  return (await conversation.agent(context)).tools.map((tool) => tool.name);
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation.
 *
 * A brand-new session offers only `get_booking`: the governed tool is registered but not offered, so it is
 * not declared to the model. Its *name* still appears in the system prompt, which does not make it callable.
 * `root({ agent })` applies only when the root is *created*, so asking
 * to offer the governed tool on a session that already exists goes through `configure()` instead.
 *
 * Automatic compaction is switched off so nothing summarizes behind the experiment's back.
 */
export async function openHarness(
  storage: Storage,
  options: OpenHarnessOptions,
  context: Context,
): Promise<OpenedHarness> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);
  const { tools, registry } = options.booking;

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      settings: { compaction: { enabled: false, backgroundTokens: 0 } },
      onReport:
        options.onReport ??
        ((error) => console.error(`[Report] hook failure swallowed by the harness: ${error instanceof Error ? error.message : String(error)}`)),
    },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: {
      model: { provider: selection.provider, modelId: selection.modelId },
      tools: [tools.getBooking],
    },
  });

  if (options.offerGovernedTool === true && !(await offeredToolNames(root, context)).includes(GOVERNED_TOOL_NAME)) {
    await root.configure({ tools: [tools.getBooking, tools.updateBookingStatus] }, context);
  }

  return { harness, root, inspection };
}
