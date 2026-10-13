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

import type { AuditSink } from "./audit-log.js";
import { BookingRepository } from "./booking-repository.js";
import type { RequestBindings } from "./correlation.js";
import { createEgressBackstop, type EgressBackstop, type ForbiddenValue } from "./egress.js";
import type { EffectLedger } from "./effect-ledger.js";
import {
  createGovernanceExtension,
  READ_TOOL_NAME,
  type ToolPolicy,
  WRITE_TOOL_NAME,
} from "./governance-hooks.js";

export { READ_TOOL_NAME, WRITE_TOOL_NAME };
export type ReplayPolicy = "safe" | "unsafe";

export const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, status, or containers.
  A booking can have several containers; a status belongs to the booking as a whole, never to one
  container. List every container the tool returns.
- update_booking_status changes a booking's status (the whole booking). Only call it when the user
  explicitly asks for a status change, and only for the booking they named. If a change is rejected,
  tell the user plainly and give the reason you were given; do not retry with different wording.
- If update_booking_status is not offered to you as a tool at all, say so plainly instead of
  attempting a workaround.
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

export const DEFAULT_OFFERED_TOOL_NAMES: readonly string[] = [READ_TOOL_NAME, WRITE_TOOL_NAME];

export interface BookingRegistryOptions {
  /** The application's own session id; written into every audit record. */
  sessionId: string;
  /** Required, with no silent default: where governance decisions go is the point of the composition. */
  auditLog: AuditSink;
  bindings: RequestBindings;
  effects: EffectLedger;
  repository?: BookingRepository;
  policies?: Readonly<Record<string, ToolPolicy>>;
  omitHooksForContractTest?: boolean;
  /** Values that must never reach a provider. Installs the backstop; leaving it unset installs no egress check. */
  forbidden?: readonly ForbiddenValue[];
  omitBackstopForContractTest?: boolean;
}

/**
 * Three extensions, three jobs, and nothing in them is stored: a conversation stores only the *names* of the
 * extensions and tools it selects, so this code must be installed again by every process that reopens the
 * session. `booking` carries only the prompt. `booking-governance` carries both tools *and* the hooks that
 * guard them. `egress-backstop` is the last check before a request leaves.
 */
export function createBookingRegistry(options: BookingRegistryOptions) {
  const repository = options.repository ?? BookingRepository.fromDefaultFixture();
  const governance = createGovernanceExtension({
    sessionId: options.sessionId,
    auditLog: options.auditLog,
    repository,
    bindings: options.bindings,
    effects: options.effects,
    ...(options.policies ? { policies: options.policies } : {}),
    ...(options.omitHooksForContractTest ? { omitHooksForContractTest: true } : {}),
  });
  const backstop: EgressBackstop | undefined =
    options.forbidden && !options.omitBackstopForContractTest ? createEgressBackstop(options.forbidden) : undefined;

  const booking = defineExtension({ name: "booking", sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })] });
  const registry = createRegistry();
  registry.install(booking);
  registry.install(governance.extension);
  if (backstop) registry.install(backstop.extension);

  const tools = governance.tools;
  const toolReplayByName = new Map<string, ReplayPolicy>(
    [tools.getBooking, tools.updateBookingStatus].map((tool) => [tool.name, tool.replay ?? "unsafe"]),
  );
  /** The installed extensions, exposed so a test can assemble a *different* registry from Lab 15's own pieces. */
  const extensions = { booking, governance: governance.extension, backstop: backstop?.extension };
  return { registry, repository, tools, backstop, toolReplayByName, extensions };
}

export type BookingRegistry = ReturnType<typeof createBookingRegistry>;

/** The tool names a conversation's next model request will offer, in order. */
export async function offeredToolNames(conversation: Conversation, context: Context): Promise<string[]> {
  return (await conversation.agent(context)).tools.map((tool) => tool.name);
}

/**
 * What the session had stored versus what the application wants *now*. For a conversation that already
 * exists Pi keeps the stored tool offer and ignores the one passed to `root({ agent })`, which applies only
 * when the root is created. The application therefore reconciles explicitly.
 */
export interface ToolSetReconciliation {
  persisted: readonly string[];
  desired: readonly string[];
  /** `true` when they differed and the stored set was replaced (a durable configuration commit). */
  reconciled: boolean;
}

export interface OpenedHarness {
  harness: Harness;
  root: Conversation;
  /** Unfinished tasks and unsettled submissions found when the harness attached (Lab 08's topic). */
  inspection: HarnessInspection;
  toolSet: ToolSetReconciliation;
}

export interface OpenHarnessOptions {
  models: Models;
  selection?: ModelSelection;
  booking: BookingRegistry;
  /** The tools the application offers now. Defaults to both. A name that is not a registered tool is an error. */
  offeredToolNames?: readonly string[];
  /**
   * Receives every hook failure the harness swallowed instead of failing the call — here, an `afterTool` audit
   * write that threw. `HarnessOptions.onReport` defaults to a no-op, which would make that failure silent.
   */
  onReport?: (error: unknown) => void;
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation, with the offered
 * tool set reconciled to the application's current configuration. Automatic compaction is switched off so
 * nothing summarizes behind an experiment's back.
 */
export async function openHarness(storage: Storage, options: OpenHarnessOptions, context: Context): Promise<OpenedHarness> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  assertModelAvailable(options.models, selection);
  const { registry, tools } = options.booking;
  const byName = new Map([tools.getBooking, tools.updateBookingStatus].map((tool) => [tool.name, tool] as const));

  const desiredNames = [...(options.offeredToolNames ?? DEFAULT_OFFERED_TOOL_NAMES)];
  const unknown = desiredNames.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown tool name(s) in offeredToolNames: ${unknown.join(", ")}`);
  }
  const desiredTools = desiredNames.map((name) => byName.get(name)!);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      settings: { compaction: { enabled: false, backgroundTokens: 0 } },
      onReport: options.onReport ?? ((error) => console.error(`[Report] hook failure swallowed by the harness: ${error instanceof Error ? error.message : String(error)}`)),
    },
    context,
  );
  const inspection = await harness.inspect(context);
  const root = await harness.root(context, {
    agent: { model: { provider: selection.provider, modelId: selection.modelId }, tools: desiredTools },
  });

  const persisted = await offeredToolNames(root, context);
  const same = [...persisted].sort().join("\0") === [...desiredNames].sort().join("\0");
  if (!same) {
    await root.configure({ tools: desiredTools }, context);
  }
  return { harness, root, inspection, toolSet: { persisted, desired: desiredNames, reconciled: !same } };
}
