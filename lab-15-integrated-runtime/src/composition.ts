import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Harness, HarnessInspection, Storage } from "@earendil-works/pi-durable";
import type { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";

import type { AuditRecord, AuditSink } from "./audit-log.js";
import { appendCaseNote, type CaseNoteData, type CaseNoteWritePolicy, projectCaseNote } from "./case-note-entries.js";
import { RequestBindings } from "./correlation.js";
import {
  createBookingRegistry,
  type BookingRegistry,
  type ModelSelection,
  openHarness,
  type ToolSetReconciliation,
} from "./create-harness.js";
import { EffectLedger } from "./effect-ledger.js";
import { EgressViolationError, findViolations, type ForbiddenValue, preflightEgress } from "./egress.js";
import type { ToolPolicy } from "./governance-hooks.js";
import { attachTelemetry, type TelemetryHandle } from "./harness-telemetry.js";
import { attachTraceLogger, type TraceHandle, type TraceWriter } from "./harness-trace-logger.js";
import {
  answerText,
  type IntegratedRunResult,
  operationOf,
  requestSlice,
  toolOutcomesOf,
  verifyMechanism,
} from "./run-result.js";
import { BACKGROUND_CONTEXT } from "./session-store.js";
import { listEntries } from "./transcript.js";

export type ComponentName = "governance-hooks" | "telemetry" | "egress-preflight" | "egress-backstop";

export interface IntegratedRuntimeOptions {
  storage: Storage;
  /** The application's own session id; written into every audit record. */
  sessionId: string;
  models: Models;
  selection?: ModelSelection;
  /** Where governance decisions are durably recorded. Required — there is no silent default. */
  auditLog: AuditSink;
  telemetry: InMemoryTelemetryContext;
  repository?: BookingRegistry["repository"];
  /** The tools offered now. Defaults to both. Reopening a session reconciles the stored set to this one. */
  offeredToolNames?: readonly string[];
  /** Replaces the default policy table (test seam for policy-exception injection). */
  policies?: Readonly<Record<string, ToolPolicy>>;
  /**
   * Values that must never reach a provider. When set, three layers apply: a write-time check on case notes,
   * a per-request preflight, and a backstop on every provider request. Leaving it unset means **no** egress
   * check at all.
   */
  egress?: { forbidden: readonly ForbiddenValue[] };
  /** Writes one human-readable trace line per event, tagged with the request in flight. */
  trace?: TraceWriter;
  /** Receives hook failures the harness swallowed (an `afterTool` audit write that threw). Default: collected on `runtime.reports`. */
  onReport?: (error: unknown) => void;
  context?: Context;
  /**
   * Contract-test only. Leaves a required component out so a test can prove the cross-component invariants
   * notice. Production callers never pass this.
   */
  omitForContractTest?: readonly ComponentName[];
}

export interface IntegratedRuntime {
  harness: Harness;
  root: Conversation;
  inspection: HarnessInspection;
  repository: BookingRegistry["repository"];
  effects: EffectLedger;
  bindings: RequestBindings;
  toolSet: ToolSetReconciliation;
  /** Every audit record that reached the sink (a record whose write threw is not listed). */
  auditRecords: readonly AuditRecord[];
  /** Hook failures the harness swallowed instead of failing a call. */
  reports: readonly unknown[];
  /** Submit one user request and return a structured, correlated result. One at a time per conversation. */
  request(requestId: string, prompt: string): Promise<IntegratedRunResult>;
  /**
   * Appends a durable case note. With `egress` configured, a projection that carries a forbidden value is
   * refused *before* it is committed (throws `EgressViolationError`): the earliest layer, because in Pi 1.1 a
   * note's contribution to model context is decided once, at write time, and then stored.
   */
  appendCaseNote(note: CaseNoteData, policy: CaseNoteWritePolicy): Promise<void>;
  /** Stops the event streams, closes any span still open, then closes the harness. Required before the same storage is reopened. */
  close(): Promise<void>;
}

/**
 * The composition root: the one place where storage, harness, governance, audit, effect ledger, egress, and
 * telemetry are wired together. Reopening a session means calling this again — nothing about governance or
 * telemetry is inherited from an earlier harness instance.
 */
export async function openIntegratedRuntime(options: IntegratedRuntimeOptions): Promise<IntegratedRuntime> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const omit = new Set(options.omitForContractTest ?? []);
  const bindings = new RequestBindings();
  const effects = new EffectLedger();

  const auditRecords: AuditRecord[] = [];
  const teedAudit: AuditSink = {
    async record(record) {
      await options.auditLog.record(record);
      auditRecords.push(record);
    },
  };

  const booking = createBookingRegistry({
    sessionId: options.sessionId,
    auditLog: teedAudit,
    bindings,
    effects,
    ...(options.repository ? { repository: options.repository } : {}),
    ...(options.policies ? { policies: options.policies } : {}),
    ...(omit.has("governance-hooks") ? { omitHooksForContractTest: true } : {}),
    ...(options.egress ? { forbidden: options.egress.forbidden } : {}),
    ...(omit.has("egress-backstop") ? { omitBackstopForContractTest: true } : {}),
  });

  const reports: unknown[] = [];
  const { harness, root, inspection, toolSet } = await openHarness(
    options.storage,
    {
      models: options.models,
      ...(options.selection ? { selection: options.selection } : {}),
      booking,
      ...(options.offeredToolNames ? { offeredToolNames: options.offeredToolNames } : {}),
      onReport: (error) => {
        reports.push(error);
        options.onReport?.(error);
      },
    },
    context,
  );
  const conversationId = Number(root.id);

  const telemetryHandle: TelemetryHandle | undefined = omit.has("telemetry")
    ? undefined
    : await attachTelemetry(harness, root.id, { telemetry: options.telemetry, toolReplayByName: booking.toolReplayByName }, context);
  const traceHandle: TraceHandle | undefined = options.trace
    ? await attachTraceLogger(harness, root.id, options.trace, context, { tag: () => bindings.current(conversationId)?.requestId })
    : undefined;

  const forbidden = options.egress?.forbidden;

  function refused(requestId: string, errorCode: string, errorMessage: string): IntegratedRunResult {
    return {
      correlation: { requestId, sessionId: options.sessionId, conversationId },
      operation: { status: "rejected", errorCode, errorMessage },
      toolOutcomes: [],
      businessEffects: [],
      mechanism: { ok: true, problems: [], checked: true },
    };
  }

  async function request(requestId: string, prompt: string): Promise<IntegratedRunResult> {
    // Pi deduplicates on (conversation, requestId): a reused id returns the ORIGINAL submission and never
    // runs the new prompt. Say so instead of presenting an old answer as this prompt's.
    const existing = await options.storage.submissionByRequest(root.id, requestId, context);
    if (existing) {
      // `wait()` on an unsettled submission resumes scheduling, so never call it here: a submission that is
      // still queued or placed (in flight, or left behind by a crashed process) belongs to a run that must be
      // resumed deliberately, not executed behind a result labelled "deduplicated".
      if (existing.status !== "done" && existing.status !== "unanswered") {
        return refused(
          requestId,
          "request_unsettled",
          `Request id ${requestId} belongs to a submission that has not settled (${existing.status}); it is not re-run and not reported as an answer.`,
        );
      }
      const settled = await (await harness.submission(existing.id, context))?.wait(context);
      if (settled) {
        const entries = await listEntries(root, context);
        const slice = requestSlice(entries, settled);
        const outcomes = toolOutcomesOf(slice);
        const answer = answerText(entries, settled);
        return {
          correlation: { requestId, sessionId: options.sessionId, conversationId, submissionId: Number(settled.id) },
          operation: operationOf(settled),
          deduplicated: true,
          ...(answer === undefined ? {} : { assistantAnswer: answer }),
          toolOutcomes: outcomes,
          businessEffects: effects.forTasks(new Set(outcomes.flatMap((o) => (o.taskId === undefined ? [] : [o.taskId])))),
          mechanism: { ok: true, problems: [], checked: false },
        };
      }
    }

    if (forbidden && !omit.has("egress-preflight")) {
      const labels = await preflightEgress(root, forbidden, prompt, context);
      if (labels.length > 0) {
        return refused(
          requestId,
          "egress_violation",
          `Request refused before submission: prohibited content (${labels.join(", ")}). No provider request was made.`,
        );
      }
    }

    const spansBefore = options.telemetry.getSpans().length;
    const backstopBefore = booking.backstop?.violations.length ?? 0;
    const auditBefore = auditRecords.length;

    bindings.set(conversationId, { requestId, sessionId: options.sessionId });
    let settled;
    try {
      settled = await (await root.submit({ type: "input", content: prompt, requestId }, context)).wait(context);
      await Promise.all([telemetryHandle?.settled(settled.id), traceHandle?.settled(settled.id)]);
    } finally {
      bindings.clear(conversationId);
    }

    const entries = await listEntries(root, context);
    const slice = requestSlice(entries, settled);
    const toolOutcomes = toolOutcomesOf(slice);
    const taskIds = new Set(toolOutcomes.flatMap((o) => (o.taskId === undefined ? [] : [o.taskId])));
    const businessEffects = effects.forTasks(taskIds);
    const requestAudit = auditRecords.slice(auditBefore).filter((record) => record.conversationId === conversationId);

    const sliceIds = new Set(slice.map((entry) => Number(entry.id)));
    const auditJoins = await Promise.all(
      [...new Set(requestAudit.map((record) => record.taskId))].map(async (taskId) => {
        const task = await harness.getTask(taskId as never, context);
        const assistant = (task?.input as { assistant?: number } | undefined)?.assistant;
        return { taskId, inRequest: assistant !== undefined && sliceIds.has(Number(assistant)) };
      }),
    );

    const newSpans = options.telemetry.getSpans().slice(spansBefore);
    const runSpan = newSpans.find((span) => span.name === "lab.run");
    const operation = operationOf(settled);
    const answer = answerText(entries, settled);

    const mechanism = verifyMechanism({
      requestId,
      operationStatus: operation.status,
      auditRecords: requestAudit,
      auditJoins,
      effects: businessEffects,
      toolOutcomes,
      governanceInstalled: !omit.has("governance-hooks"),
      backstopHits: (booking.backstop?.violations.slice(backstopBefore) ?? []).flatMap((violation) => violation.labels),
      telemetry: telemetryHandle
        ? {
            runSpanFound: runSpan !== undefined,
            runSpanSettled: runSpan?.settled === true,
            errorRequestSpanFound: newSpans.some((span) => span.name === "lab.ai.request" && span.attributes["lab.ai.stop_reason"] === "error"),
            bridgeWarnings: telemetryHandle.bridge.warnings,
          }
        : undefined,
    });

    return {
      correlation: { requestId, sessionId: options.sessionId, conversationId, submissionId: Number(settled.id) },
      operation,
      ...(answer === undefined ? {} : { assistantAnswer: answer }),
      toolOutcomes,
      businessEffects,
      mechanism,
    };
  }

  async function appendNote(note: CaseNoteData, policy: CaseNoteWritePolicy): Promise<void> {
    if (forbidden) {
      const labels = findViolations(policy === "projected" ? (projectCaseNote(note) ?? []) : [], forbidden);
      if (labels.length > 0) throw new EgressViolationError(labels);
    }
    await appendCaseNote(root, note, policy, context);
  }

  return {
    harness,
    root,
    inspection,
    repository: booking.repository,
    effects,
    bindings,
    toolSet,
    auditRecords,
    reports,
    request,
    appendCaseNote: appendNote,
    async close() {
      await traceHandle?.stop();
      await telemetryHandle?.stop();
      await harness.close(context);
    },
  };
}
