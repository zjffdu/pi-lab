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

import type { AuditLog } from "./audit-log.js";
import type { BookingRepository } from "./booking-repository.js";
import { evaluateUpdateBookingStatusPolicy } from "./tool-policy.js";
import { createUpdateBookingStatusTool } from "./update-booking-status-tool.js";

export const GOVERNED_TOOL_NAME = "update_booking_status";
export const GOVERNANCE_EXTENSION_NAME = "booking-governance";

export interface GovernanceOptions {
  /** The application's own session id. Storage has no external id for it, so the audit record gets it from here. */
  sessionId: string;
  auditLog: AuditLog;
  repository: BookingRepository;
  /**
   * Demo/test-only. When `true`, `beforeTool` throws unconditionally for `update_booking_status`,
   * before policy is evaluated: a bug in the policy code, as opposed to a deliberate decline. Both
   * paths end as a blocked call, and that convergence is itself a finding — the harness, not this
   * file, turns a `beforeTool` throw into a block.
   */
  simulatePolicyBug?: boolean;
}

function pickArgs(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const picked: Record<string, string> = {};
  if (typeof args.bookingNo === "string") picked.bookingNo = args.bookingNo;
  if (typeof args.newStatus === "string") picked.newStatus = args.newStatus;
  return picked;
}

/**
 * `beforeTool` runs after the call has resolved to an offered tool and its arguments have validated,
 * and before the harness commits the durable intent that precedes `execute()`. It is the only hook
 * that sees *every* such attempt, allowed or blocked: a blocked call never reaches `execute()`, so it
 * never reaches `afterTool` either. The audit write for a decision therefore belongs here — a design
 * that audited only from `afterTool` would have no record of any declined attempt.
 *
 * The audit write is `await`ed with no surrounding `try`/`catch`, on purpose. The harness catches any
 * throw from a `beforeTool` hook and turns it into a block (its own type comment: "A throw blocks"), so
 * an audit-sink failure and a policy bug become the same observable outcome: the tool does not run.
 * Letting the audit failure propagate is this lab's explicit choice for the audit-failure question:
 * if this decision cannot be recorded, the effect does not happen.
 */
export function createBeforeToolHook(options: GovernanceOptions) {
  return async (
    call: ToolCall,
    api: HookApi,
    _context: Context,
  ): Promise<{ readonly arguments?: JsonObject; readonly block?: string } | undefined> => {
    if (call.name !== GOVERNED_TOOL_NAME) {
      return undefined;
    }

    if (options.simulatePolicyBug) {
      throw new Error("Simulated bug in the beforeTool policy hook (not a deliberate decline).");
    }

    const decision = evaluateUpdateBookingStatusPolicy(call.arguments, options.repository);

    await options.auditLog.record({
      at: new Date().toISOString(),
      sessionId: options.sessionId,
      conversationId: api.conversationId,
      taskId: api.taskId,
      toolCallId: call.id,
      toolName: call.name,
      phase: "before_tool",
      decision: decision.allowed ? "allowed" : "blocked",
      reason: decision.reason,
      args: pickArgs(call.arguments),
    });

    return decision.allowed ? undefined : { block: decision.reason ?? "Blocked by local policy." };
  };
}

/**
 * Runs after `execute()` has already returned, so for `update_booking_status` the in-memory mutation
 * has happened by the time this is called. Pure audit here: it never replaces the result.
 *
 * A throw from this hook is fail-open, and nothing in this file chooses that. The harness runs every
 * hook through one `hooks.each` loop that catches a handler's throw and hands it to `onReport`; only
 * `beforeTool`'s own callback adds a second catch that turns the throw into a block. For `afterTool`
 * there is nothing left to block — `execute()` already ran — so the result stands, unmodified, and the
 * failed audit write is visible only through `onReport` (default: a no-op). The residual risk is a real
 * mutation with a `before_tool` record but no `after_tool` record. `tests/governance-pipeline.test.ts`
 * pins this behavior.
 */
export function createAfterToolHook(options: GovernanceOptions) {
  return async (
    call: ToolCall,
    result: ToolExecutionResult,
    api: HookApi,
    _context: Context,
  ): Promise<ToolExecutionResult | undefined> => {
    if (call.name !== GOVERNED_TOOL_NAME) {
      return undefined;
    }

    await options.auditLog.record({
      at: new Date().toISOString(),
      sessionId: options.sessionId,
      conversationId: api.conversationId,
      taskId: api.taskId,
      toolCallId: call.id,
      toolName: call.name,
      phase: "after_tool",
      decision: result.isError ? "errored" : "executed",
      args: pickArgs(call.arguments),
    });

    return undefined;
  };
}

/**
 * The governed tool and its guard are one extension, installed and selected together. Hooks belong to
 * an extension and conversations store only extension *names*: a process that reopened a session
 * after installing the tool but forgetting the guard would run the tool ungoverned, with nothing
 * reporting it. Bundling them means there is no registry state in which `update_booking_status`
 * exists and its policy does not — `tests/governance-pipeline.test.ts` pins that.
 *
 * Hooks have no ids of their own in Pi 1.1; the extension's name is the stable identity a reader can
 * grep for in a registry and in a conversation's stored selection.
 */
export function createGovernanceExtension(options: GovernanceOptions) {
  const updateBookingStatusTool = createUpdateBookingStatusTool(options.repository);
  const extension = defineExtension({
    name: GOVERNANCE_EXTENSION_NAME,
    tools: [updateBookingStatusTool],
    hooks: [
      hook(ToolTask, {
        beforeTool: createBeforeToolHook(options),
        afterTool: createAfterToolHook(options),
      }),
    ],
  });
  return { extension, updateBookingStatusTool };
}
