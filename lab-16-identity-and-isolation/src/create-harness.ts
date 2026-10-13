import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  section,
  type Storage,
} from "@earendil-works/pi-durable";

import type { Booking, TenantBookingStore } from "./booking-store.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import type { ProviderBoundary } from "./provider-boundary.js";
import type { ScopedCache } from "./scoped-cache.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export const SYSTEM_PROMPT = `You are a booking assistant for one organization in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, status, or containers.
  A booking can have several containers; a status belongs to the booking as a whole.
- You can only see your own organization's bookings. If get_booking reports no booking, say so
  plainly; do not guess and do not suggest that it exists elsewhere.
- Keep answers concise.`;

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export function modelSelectionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelSelection {
  return {
    provider: environment.PI_PROVIDER?.trim() || "deepseek",
    modelId: environment.PI_MODEL?.trim() || "deepseek-flash",
  };
}

/** The model registry and the chosen model, kept together so tests can substitute a scripted provider. */
export interface ModelBinding {
  models: Models;
  selection: ModelSelection;
}

export function modelBindingFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelBinding {
  const binding: ModelBinding = { models: builtinModels(), selection: modelSelectionFromEnvironment(environment) };
  assertModelAvailable(binding);
  return binding;
}

/** Fails at startup with the catalog's real ids, instead of failing inside the first model request. */
export function assertModelAvailable(binding: ModelBinding): void {
  const { models, selection } = binding;
  if (models.getModel(selection.provider, selection.modelId)) {
    return;
  }

  const available = models
    .getModels(selection.provider)
    .map((candidate) => candidate.id)
    .slice(0, 12)
    .join(", ");
  throw new Error(
    `Unknown model ${selection.provider}/${selection.modelId}. Available model ids include: ${available || "none"}`,
  );
}

export interface RequestRegistryOptions {
  securityContext: SecurityContext;
  store: TenantBookingStore;
  cache: ScopedCache<Booking>;
  /** The provider-boundary detector for this request, if any. */
  boundary?: ProviderBoundary;
}

/**
 * Everything principal-dependent — the `get_booking` tool (closed over the `SecurityContext`) and the
 * boundary detector (armed by the caller with the *other* tenants' markers) — is built here, per request,
 * from the server-created context. Nothing in a registry is stored: a conversation stores only the *names*
 * of the extensions and tools it selects, so a reopened session is governed by whoever is calling now, not
 * by whoever created it.
 */
export function createRequestRegistry(options: RequestRegistryOptions) {
  assertSecurityContext(options.securityContext);
  const getBookingTool = createGetBookingTool(options.securityContext, options.store, options.cache);

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "booking",
      tools: [getBookingTool],
      sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
    }),
  );
  if (options.boundary) {
    registry.install(options.boundary.extension);
  }
  return { registry, getBookingTool };
}

export type RequestRegistry = ReturnType<typeof createRequestRegistry>;

export interface OpenedHarness {
  harness: Harness;
  root: Conversation;
}

export interface OpenHarnessOptions {
  binding: ModelBinding;
  requestRegistry: RequestRegistry;
  /** Receives every hook failure the harness swallowed instead of failing the call; its default is a no-op. */
  onReport?: (error: unknown) => void;
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation. `root({ agent })`
 * applies only when the root is *created*: on a reopened session the conversation keeps the model and tool
 * offer it was created with, and only the installed registry (this request's) supplies the implementation.
 * Automatic compaction is switched off so nothing summarizes behind the experiment's back.
 * The caller owns the returned harness and must `close()` it, which also closes the session's storage.
 */
export async function openHarness(storage: Storage, options: OpenHarnessOptions, context: Context): Promise<OpenedHarness> {
  assertModelAvailable(options.binding);
  const { models, selection } = options.binding;
  const { registry, getBookingTool } = options.requestRegistry;

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { compaction: { enabled: false, backgroundTokens: 0 } },
      onReport:
        options.onReport ??
        ((error) => console.error(`[Report] hook failure swallowed by the harness: ${error instanceof Error ? error.message : String(error)}`)),
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: selection.provider, modelId: selection.modelId }, tools: [getBookingTool] },
    });
    return { harness, root };
  } catch (error) {
    // `Harness.open` closes the storage itself when it fails; once it has succeeded, closing the harness is
    // what closes the storage (pi-durable `session.js`), so a failure here must close the harness.
    await harness.close(context).catch((closeError) => options.onReport?.(closeError));
    throw error;
  }
}
