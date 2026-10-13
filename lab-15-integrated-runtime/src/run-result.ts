import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord, SettledSubmissionRecord } from "@earendil-works/pi-durable";

import type { AuditRecord } from "./audit-log.js";
import type { EffectRecord } from "./effect-ledger.js";
import { errorDiagnostic, messageText } from "./transcript.js";

/**
 * How one tool call ended, *as a tool*, read from the machine-readable `code` Pi stores on the result entry
 * (`diagnostics[].code`). A bare `isError` cannot tell these apart, and neither can telemetry (see Finding 3):
 *
 * - `ok` — it ran and returned normally.
 * - `error` — it ran and threw (`tool_error`), or ended some other way Pi reports (`code` says which).
 * - `blocked` — a `beforeTool` hook declined it **or threw**. Both end as `blocked`; only the audit record
 *   says which (a decision, or no decision at all).
 * - `unavailable` — the model asked for a tool that is not offered (`tool_unavailable`). No hook ran.
 * - `invalid_arguments` — the arguments failed schema validation. No hook ran.
 * - `unresolved` — the assistant asked for a call and no result entry exists for it.
 *
 * A tool outcome of `ok` says nothing about whether a business effect happened; that is `businessEffects`.
 */
export type ToolOutcomeStatus = "ok" | "error" | "blocked" | "unavailable" | "invalid_arguments" | "unresolved";

export interface ToolOutcome {
  toolCallId: string;
  toolName: string;
  status: ToolOutcomeStatus;
  /** Pi's diagnostic code for an error result, as stored. */
  code?: string;
  /** The `pi.tool` task that produced the result entry; the join key to audit records and effects. */
  taskId?: number;
}

/**
 * `completed` — the submission was answered. `failed` — it settled `unanswered` (for example `model_error`
 * when the provider failed). `rejected` — this request was refused before anything was submitted, so no run,
 * no provider request, and nothing durable happened.
 */
export type OperationStatus = "completed" | "failed" | "rejected";

export interface IntegratedRunResult {
  correlation: {
    requestId: string;
    sessionId: string;
    conversationId: number;
    /** Absent only for a request refused before submission. */
    submissionId?: number;
  };
  operation: { status: OperationStatus; errorCode?: string; errorMessage?: string };
  /**
   * `true` when this `requestId` had already been submitted on this conversation: Pi treats it as an
   * idempotency key and returned the original submission instead of running the new prompt.
   */
  deduplicated?: true;
  /** Present only for a completed submission: the entry Pi recorded as its answer. Never an earlier preamble. */
  assistantAnswer?: string;
  toolOutcomes: ToolOutcome[];
  /** What actually changed in the business system — the effect ledger, not the model's claim. */
  businessEffects: EffectRecord[];
  /**
   * Did the machinery hold together for this request, independent of whether the behavior was right?
   * `checked: false` means no evidence was collected (a deduplicated request), so `ok` is vacuous.
   */
  mechanism: { ok: boolean; problems: string[]; checked: boolean };
}

/** The entries one submission produced: after its input entry, up to its answer (or the end, if unanswered). */
export function requestSlice(entries: readonly EntryRecord[], record: Pick<SettledSubmissionRecord, "entry" | "answer">): EntryRecord[] {
  if (record.entry === undefined) return [];
  const first = Number(record.entry);
  const last = record.answer === undefined ? Number.POSITIVE_INFINITY : Number(record.answer);
  return entries.filter((entry) => Number(entry.id) > first && Number(entry.id) <= last);
}

export function operationOf(record: SettledSubmissionRecord): IntegratedRunResult["operation"] {
  if (record.status === "done") return { status: "completed" };
  return {
    status: "failed",
    errorCode: record.reason,
    ...(record.detail === undefined ? {} : { errorMessage: String(record.detail) }),
  };
}

function isAssistant(message: Message | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

/** The text of the entry Pi recorded as a completed submission's answer. */
export function answerText(entries: readonly EntryRecord[], record: SettledSubmissionRecord): string | undefined {
  if (record.status !== "done") return undefined;
  const message = entries.find((entry) => entry.id === record.answer)?.model?.[0];
  if (!isAssistant(message)) return undefined;
  const text = messageText(message);
  return text.length > 0 ? text : undefined;
}

const STATUS_BY_CODE: Readonly<Record<string, ToolOutcomeStatus>> = {
  blocked: "blocked",
  tool_unavailable: "unavailable",
  invalid_arguments: "invalid_arguments",
};

/** One outcome per tool call the assistant requested inside this request's entries, in request order. */
export function toolOutcomesOf(slice: readonly EntryRecord[]): ToolOutcome[] {
  const used = new Set<number>();
  const outcomes: ToolOutcome[] = [];
  for (const entry of slice) {
    const message = entry.model?.[0];
    if (!isAssistant(message)) continue;
    for (const call of message.content) {
      if (call.type !== "toolCall") continue;
      const result = slice.find(
        (candidate) =>
          Number(candidate.id) > Number(entry.id) &&
          !used.has(Number(candidate.id)) &&
          candidate.model?.[0]?.role === "toolResult" &&
          candidate.model[0].toolCallId === call.id,
      );
      if (!result) {
        outcomes.push({ toolCallId: call.id, toolName: call.name, status: "unresolved" });
        continue;
      }
      used.add(Number(result.id));
      const resultMessage = result.model?.[0];
      const code = errorDiagnostic(result)?.code;
      const isError = resultMessage?.role === "toolResult" && resultMessage.isError;
      outcomes.push({
        toolCallId: call.id,
        toolName: call.name,
        status: !isError ? "ok" : (code === undefined ? undefined : STATUS_BY_CODE[code]) ?? "error",
        ...(code ? { code } : {}),
        ...(result.byTaskId === undefined ? {} : { taskId: Number(result.byTaskId) }),
      });
    }
  }
  return outcomes;
}

export interface MechanismEvidence {
  requestId: string;
  operationStatus: OperationStatus;
  auditRecords: readonly AuditRecord[];
  /** Each audit record's `taskId` resolved through durable state: does the tool task's assistant entry lie inside this request? */
  auditJoins: readonly { taskId: number; inRequest: boolean }[];
  effects: readonly EffectRecord[];
  toolOutcomes: readonly ToolOutcome[];
  governanceInstalled: boolean;
  /** Labels the egress backstop had to withhold during this request. A hit means an upstream layer failed. */
  backstopHits: readonly string[];
  /** `undefined` when telemetry is not installed. */
  telemetry:
    | {
        runSpanFound: boolean;
        runSpanSettled: boolean;
        /** For a failed operation: was a provider-request span with stop reason `error` recorded? */
        errorRequestSpanFound: boolean;
        bridgeWarnings: readonly string[];
      }
    | undefined;
}

/**
 * Checks that the *machinery* held together for this request, without judging the answer. Each clause is a
 * cross-component invariant that no single lab could check on its own.
 */
export function verifyMechanism(evidence: MechanismEvidence): { ok: boolean; problems: string[]; checked: true } {
  const problems: string[] = [];
  const ran = evidence.operationStatus !== "rejected";

  if (!evidence.governanceInstalled) problems.push("governance hooks are not installed");
  if (!evidence.telemetry) problems.push("telemetry is not installed");

  for (const record of evidence.auditRecords) {
    if (record.requestId !== evidence.requestId) {
      problems.push(`audit record for task ${record.taskId} carries requestId=${String(record.requestId)}, expected ${evidence.requestId}`);
    }
  }
  for (const join of evidence.auditJoins) {
    if (!join.inRequest) problems.push(`audit record's task ${join.taskId} does not resolve to a tool call inside this request`);
  }

  const auditFor = (taskId: number | undefined, phase: AuditRecord["phase"]) =>
    taskId === undefined ? [] : evidence.auditRecords.filter((r) => r.taskId === taskId && r.phase === phase);

  for (const effect of evidence.effects) {
    if (!auditFor(effect.taskId, "before_tool").some((r) => r.decision === "allowed")) {
      problems.push(`business effect ${effect.businessActionId} has no allowed before_tool audit record`);
    }
  }

  for (const outcome of evidence.toolOutcomes) {
    const label = `tool call ${outcome.toolCallId} (${outcome.toolName})`;
    switch (outcome.status) {
      case "unresolved":
        problems.push(`${label} has no result entry`);
        break;
      case "unavailable":
      case "invalid_arguments":
        break; // Pi refused it before any hook ran: no audit record is expected, and no effect is possible.
      case "blocked":
        if (!auditFor(outcome.taskId, "before_tool").some((r) => r.decision === "blocked")) {
          problems.push(`${label} was blocked but no blocked decision was audited (a policy exception or an audit-sink failure)`);
        }
        break;
      default: {
        // `ok` or `error`: it executed.
        if (!auditFor(outcome.taskId, "before_tool").some((r) => r.decision === "allowed")) {
          problems.push(`${label} executed without an allowed before_tool audit record`);
        } else if (auditFor(outcome.taskId, "after_tool").length === 0) {
          problems.push(`${label} executed but its after_tool audit record is missing`);
        }
      }
    }
  }

  for (const label of evidence.backstopHits) {
    problems.push(`egress backstop had to withhold prohibited content (${label}): an upstream layer let it through`);
  }

  if (evidence.telemetry && ran) {
    if (!evidence.telemetry.runSpanFound) problems.push("no lab.run span found for this request");
    else if (!evidence.telemetry.runSpanSettled) problems.push("lab.run span was never closed");
    if (evidence.operationStatus === "failed" && !evidence.telemetry.errorRequestSpanFound) {
      problems.push("the operation failed but no lab.ai.request span with stop reason error was recorded");
    }
    for (const warning of evidence.telemetry.bridgeWarnings) problems.push(`telemetry bridge warning: ${warning}`);
  }

  return { ok: problems.length === 0, problems, checked: true };
}

export interface BehaviorExpectation {
  /** Exact set of business effects expected (bookingNo + newStatus). Empty array = "no effect". */
  effects: readonly { bookingNo: string; newStatus: string }[];
  /** Substrings the answer must contain. */
  answerIncludes?: readonly string[];
}

/** Judges the *behavior* of a run against an expectation. Independent of `mechanism`. */
export function evaluateBehavior(result: IntegratedRunResult, expectation: BehaviorExpectation): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (result.operation.status !== "completed") failures.push(`operation ${result.operation.status}`);

  const actual = result.businessEffects.map((e) => `${e.bookingNo}->${e.newStatus}`).sort();
  const expected = expectation.effects.map((e) => `${e.bookingNo}->${e.newStatus}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`effects ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`);
  }

  for (const needle of expectation.answerIncludes ?? []) {
    if (!result.assistantAnswer?.includes(needle)) failures.push(`answer does not include "${needle}"`);
  }
  return { ok: failures.length === 0, failures };
}
