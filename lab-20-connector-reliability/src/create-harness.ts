import type { Context } from "@earendil-works/chord";
import type { Message, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  type HarnessInspection,
  hook,
  section,
  type Storage,
  ToolTask,
} from "@earendil-works/pi-durable";

import { createLookupBookingTool, LOOKUP_TOOL_NAME, type LookupDetails } from "./booking-tool.js";
import { BudgetExhaustedError } from "./connector/errors.js";
import type { BookingLookupService } from "./connector/lookup.js";
import type { AttemptTrace } from "./connector/trace.js";
import type { PrincipalDirectory } from "./directory.js";
import { withOutputCap } from "./model-limits.js";
import type { RunBudget } from "./run-budget.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import type { UsageMeter } from "./usage-meter.js";

export const SYSTEM_PROMPT = `You are a booking assistant for one organization in a learning lab.

Data rules:
- Use lookup_booking before stating anything about a booking. It reads a live booking service.
  A booking can have several containers; report all of them, and remember that a status belongs to
  the booking as a whole, not to one container.
- Quote numbers and dates exactly as the tool result gives them. Totals, counts, and cutoff comparisons
  are computed by the application; do not add, subtract, or compare dates yourself.
- If a result says LOOKUP_PARTIAL, STALE, NO_RESULT, or LOOKUP_FAILED, say so plainly. Never present
  partial data as complete, and never state a total when the result says total_weight_kg=UNKNOWN.
- Do not call lookup_booking again for a booking whose lookup failed in this request. Say it could not
  be retrieved and why.
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

/** Fails at startup with the catalog's real ids, instead of failing inside the first model request. */
export function assertModelAvailable(models: Models, selection: ModelSelection): void {
  if (models.getModel(selection.provider, selection.modelId)) return;
  const available = models
    .getModels(selection.provider)
    .map((candidate) => candidate.id)
    .slice(0, 12)
    .join(", ");
  throw new Error(`Unknown model ${selection.provider}/${selection.modelId}. Available model ids include: ${available || "none"}`);
}

export function modelBindingFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelBinding {
  const models = builtinModels();
  const selection = modelSelectionFromEnvironment(environment);
  assertModelAvailable(models, selection);
  return { models, selection };
}

/**
 * Retry ownership for *model* calls. Two layers can retry a provider request — the provider SDK
 * (`settings.stream.maxRetries`, inside one request attempt) and the harness (`settings.retry`, whole
 * generation attempts). Both on would multiply. The SDK layer is pinned to 0 and the harness owns the
 * retry, with a small explicit count (its default is 3). Booking-API retries are a separate dependency
 * and live only in the connector.
 */
export interface ModelCallConfig {
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number };
  requestTimeoutMs: number;
}

export const DEFAULT_MODEL_CALL: ModelCallConfig = {
  retry: { enabled: true, maxRetries: 1, baseDelayMs: 300 },
  requestTimeoutMs: 20_000,
};

export interface Capabilities {
  lookup: BookingLookupService;
  directory: PrincipalDirectory;
}

/** Everything one request accumulates. Created per request; nothing here is shared between requests. */
export interface RunState {
  budget: RunBudget;
  trace: AttemptTrace;
  meter: UsageMeter;
  lookups: LookupDetails[];
  /** Set by `ChatService`: ends the run because a budget ran out. Fire-and-forget (see `stopForBudget`). */
  stopForBudget: () => void;
}

/**
 * The tools offered to this caller *today*, from the server-side role directory. Any role may read
 * bookings; a principal with no roles gets none. It is recomputed on every request and applied to the
 * conversation with `configure({ tools })`, because `root({ agent })` only applies at creation — a
 * reopened session would otherwise keep whatever it stored the first time.
 */
export function offeredToolNames(context: SecurityContext, directory: PrincipalDirectory): string[] {
  assertSecurityContext(context);
  return directory.rolesOf(context.tenantId, context.subject).length === 0 ? [] : [LOOKUP_TOOL_NAME];
}

/** The message a request is replaced with when a budget has already ended the run, so no session content leaves with it. */
const WITHHELD: Message[] = [{ role: "user", content: "[request withheld by the application: this request's limits are exhausted]", timestamp: 0 }];

/**
 * One registry per request: the tool and the budget hooks close over *this request's* `SecurityContext`
 * and `RunBudget`. A conversation stores only the *names* of its extension and tools, never this code, so
 * whoever reopens a session installs their own. The extension name is stable across requests, which is
 * what keeps the hooks selected on a reopened conversation.
 *
 * How each limit stops work (pi-durable 1.1 has no hook that ends a run, so all but the tool-call limit
 * work through `stopForBudget`, a `root.abort()`; see README "Things this lab found in the SDK"):
 * - tool calls: `beforeTool` blocks the call; the tool never runs, the model gets an error result.
 * - turns: `afterTools` ends the run once the limit is reached, before the next request is prepared;
 *   `beforeRequest` is the backstop.
 * - context: `beforeRequest` measures the request, aborts, and replaces its messages with a placeholder.
 * - output / usage: `afterResponse` sees every provider message, including a `length` stop.
 */
export function createRequestRegistry(security: SecurityContext, capabilities: Capabilities, run: RunState) {
  assertSecurityContext(security);
  const { budget, meter } = run;
  const lookupTool = createLookupBookingTool({
    context: security,
    lookup: capabilities.lookup,
    budget,
    trace: run.trace,
    onLookup: (details) => run.lookups.push(details),
  });

  const hooks = [
    hook(ToolTask, {
      beforeTool: () => {
        try {
          budget.reserveToolCall();
          return undefined;
        } catch (error) {
          if (!(error instanceof BudgetExhaustedError)) throw error;
          return { block: "BUDGET_EXHAUSTED: this request's tool-call limit is reached. Do not call any more tools; answer with what you already have and say what is missing." };
        }
      },
    }),
    hook(GenerationTask, {
      afterResponse: (message) => {
        meter.record(message.usage);
        if (message.stopReason === "error" || message.stopReason === "aborted") return;
        budget.recordTurn();
        if (message.stopReason === "length") budget.markExhausted("output");
      },
      afterTools: () => {
        if (!budget.turnLimitReached()) return;
        budget.markExhausted("turns");
        run.stopForBudget();
      },
      beforeRequest: (request) => {
        if (budget.turnLimitReached()) budget.markExhausted("turns");
        else if (JSON.stringify(request.messages).length > budget.limits.maxContextChars) budget.markExhausted("context");
        else return undefined;
        run.stopForBudget();
        return { messages: WITHHELD };
      },
    }),
  ];

  const registry = createRegistry();
  registry.install(defineExtension({ name: "booking-connector", tools: [lookupTool], hooks, sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })] }));
  return { registry, lookupTool, byName: { [LOOKUP_TOOL_NAME]: lookupTool } as const };
}

export type RequestRegistry = ReturnType<typeof createRequestRegistry>;

export interface OpenHarnessOptions {
  binding: ModelBinding;
  requestRegistry: RequestRegistry;
  /** Today's offer, from `offeredToolNames`. Applied to the conversation whether it is new or reopened. */
  toolNames: readonly string[];
  maxOutputTokens: number;
  modelCall?: ModelCallConfig;
  /** Receives hook/task failures the harness swallowed; its default is a no-op, so tests collect them. */
  onReport?: (error: unknown) => void;
}

export interface OpenedHarness {
  harness: Harness;
  root: Conversation;
  /** Unfinished tasks and unsettled submissions found when the harness attached (read before anything is scheduled). */
  inspection: HarnessInspection;
  /** The offer the conversation had *stored*, before today's was applied: yesterday's, not a grant. */
  restoredOffer: string[];
  /** The offer the conversation holds *now*, read back after `configure` — what the model's next request will list. */
  offered: string[];
}

/**
 * Attaches a fresh `Harness` to an already-open storage and returns its root conversation with
 * *today's* tool offer applied. Compaction is off: it would be an unbudgeted model call. The caller
 * owns the harness and must close it (and the storage).
 */
export async function openHarness(storage: Storage, options: OpenHarnessOptions, context: Context): Promise<OpenedHarness> {
  const { models, selection } = withOutputCap(options.binding, options.maxOutputTokens);
  assertModelAvailable(models, selection);
  const modelCall = options.modelCall ?? DEFAULT_MODEL_CALL;

  const tools = options.toolNames.map((name) => {
    const tool = options.requestRegistry.byName[name as keyof RequestRegistry["byName"]];
    if (!tool) throw new Error(`Unknown tool name in the offer: ${name}`);
    return tool;
  });

  const harness = await Harness.open(
    storage,
    {
      models,
      registry: options.requestRegistry.registry,
      settings: {
        compaction: { enabled: false, backgroundTokens: 0 },
        retry: modelCall.retry,
        stream: { maxRetries: 0, timeoutMs: modelCall.requestTimeoutMs },
      },
      onReport: options.onReport ?? ((error) => console.error(`[Report] harness swallowed a failure: ${error instanceof Error ? error.message : String(error)}`)),
    },
    context,
  );
  try {
    const inspection = await harness.inspect(context);
    const root = await harness.root(context, { agent: { model: { provider: selection.provider, modelId: selection.modelId }, tools } });
    const restoredOffer = (await root.agent(context)).tools.map((tool) => tool.name);
    await root.configure({ tools }, context);
    const offered = (await root.agent(context)).tools.map((tool) => tool.name);
    return { harness, root, inspection, restoredOffer, offered };
  } catch (error) {
    await harness.close(context).catch(() => undefined); // do not leak a created harness if wiring it fails
    throw error;
  }
}
