import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  type HookApi,
  type JsonObject,
  type ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable";

import type { AuditRecord, AuditSink } from "./audit-log.js";
import type { BookingRepository } from "./booking-repository.js";
import { businessActionIdFor, type RequestBindings } from "./correlation.js";
import type { EffectLedger } from "./effect-ledger.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { evaluateUpdateBookingStatusPolicy, type PolicyDecision } from "./tool-policy.js";
import { createUpdateBookingStatusTool } from "./update-booking-status-tool.js";

export const READ_TOOL_NAME = "get_booking";
export const WRITE_TOOL_NAME = "update_booking_status";
export const GOVERNANCE_EXTENSION_NAME = "booking-governance";

/** Tools whose successful execution can change business state, and so get a business-action id. */
const EFFECTFUL_TOOLS: ReadonlySet<string> = new Set([WRITE_TOOL_NAME]);

export type ToolPolicy = (args: unknown, repository: BookingRepository) => PolicyDecision;

/**
 * Deny by default. Lab 13 governed exactly one tool and ignored every other, which is unsafe in a composed
 * runtime: adding a tool would silently leave it ungoverned. Here a tool with no entry is blocked. Who may
 * read or write which resource starts in Lab 17; the read policy is a deliberate allow-all placeholder.
 */
export const DEFAULT_TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
  [READ_TOOL_NAME]: () => ({ allowed: true }),
  [WRITE_TOOL_NAME]: (args, repository) => evaluateUpdateBookingStatusPolicy(args, repository),
};

export interface GovernanceOptions {
  /** The application's own session id. Storage has no external id for it, so the audit record gets it from here. */
  sessionId: string;
  auditLog: AuditSink;
  repository: BookingRepository;
  bindings: RequestBindings;
  effects: EffectLedger;
  /** Replaces the default policy table. Test seam for policy-exception injection; production uses the default. */
  policies?: Readonly<Record<string, ToolPolicy>>;
  /**
   * Contract-test only. Builds the extension with its tools but **without** the hooks that guard them —
   * the unbundled shape that Pi 1.1 makes unnecessary to build by accident but still lets a developer build
   * on purpose. Production callers never pass this.
   */
  omitHooksForContractTest?: boolean;
}

function pickArgs(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const picked: Record<string, string> = {};
  if (typeof args.bookingNo === "string") picked.bookingNo = args.bookingNo;
  if (typeof args.newStatus === "string") picked.newStatus = args.newStatus;
  return picked;
}

function recordBase(options: GovernanceOptions, call: ToolCall, api: HookApi) {
  const conversationId = Number(api.conversationId);
  const taskId = Number(api.taskId);
  return {
    at: new Date().toISOString(),
    requestId: options.bindings.current(conversationId)?.requestId ?? null,
    sessionId: options.sessionId,
    conversationId,
    taskId,
    toolCallId: call.id,
    ...(EFFECTFUL_TOOLS.has(call.name) ? { businessActionId: businessActionIdFor(conversationId, taskId) } : {}),
    toolName: call.name,
    args: pickArgs(call.arguments),
  } satisfies Partial<AuditRecord>;
}

/**
 * Runs after the call resolved to an offered tool and its arguments validated, and before the harness commits
 * the durable intent that precedes `execute()`. It sees every such attempt, allowed or blocked: a blocked
 * call never reaches `execute()`, so never reaches `afterTool`, and an audit written only from `afterTool`
 * would have no record of a declined attempt.
 *
 * The audit write is awaited with no `try`/`catch`, on purpose. The harness turns any throw from a
 * `beforeTool` hook into a block, so an audit-sink failure and a policy bug end the same way: the tool does
 * not run. If the decision cannot be recorded, the effect does not happen.
 */
export function createBeforeToolHook(options: GovernanceOptions) {
  return async (
    call: ToolCall,
    api: HookApi,
    _context: Context,
  ): Promise<{ readonly arguments?: JsonObject; readonly block?: string } | undefined> => {
    const policy = (options.policies ?? DEFAULT_TOOL_POLICIES)[call.name];
    const decision: PolicyDecision = policy
      ? policy(call.arguments, options.repository)
      : { allowed: false, reason: `No policy is registered for tool "${call.name}"; blocked by default.` };

    await options.auditLog.record({
      ...recordBase(options, call, api),
      phase: "before_tool",
      decision: decision.allowed ? "allowed" : "blocked",
      ...(decision.reason ? { reason: decision.reason } : {}),
    });

    return decision.allowed ? undefined : { block: decision.reason ?? "Blocked by local policy." };
  };
}

/**
 * Runs after `execute()` returned, so the effect has already happened. A throw from here is swallowed by the
 * harness and reported through `HarnessOptions.onReport`, never turned into a block: the result stands. That
 * is fail-open by construction, not a choice made in this file; `verifyMechanism` reports the missing record
 * afterwards because it cannot be prevented here.
 */
export function createAfterToolHook(options: GovernanceOptions) {
  return async (
    call: ToolCall,
    result: ToolExecutionResult,
    api: HookApi,
    _context: Context,
  ): Promise<ToolExecutionResult | undefined> => {
    await options.auditLog.record({
      ...recordBase(options, call, api),
      phase: "after_tool",
      decision: result.isError ? "errored" : "executed",
    });
    return undefined;
  };
}

/**
 * Both tools and their guard are ONE extension, installed and selected together. Hooks belong to an
 * extension and a conversation stores only extension *names*, so a registry that installed a tool without
 * its hooks would run it ungoverned with nothing reporting it. With the tools inside the guard's own
 * extension, a process that reopens a session without it has no booking tools at all: they are not offered,
 * and a call to one is refused as `tool_unavailable`. Hooks have no ids in Pi 1.1; the extension name is the
 * identity to grep for.
 */
export function createGovernanceExtension(options: GovernanceOptions) {
  const getBookingTool = createGetBookingTool(options.repository);
  const updateBookingStatusTool = createUpdateBookingStatusTool(options.repository, options.effects.onChange);
  const extension = defineExtension({
    name: GOVERNANCE_EXTENSION_NAME,
    tools: [getBookingTool, updateBookingStatusTool],
    hooks: options.omitHooksForContractTest
      ? []
      : [hook(ToolTask, { beforeTool: createBeforeToolHook(options), afterTool: createAfterToolHook(options) })],
  });
  return { extension, tools: { getBooking: getBookingTool, updateBookingStatus: updateBookingStatusTool } };
}
