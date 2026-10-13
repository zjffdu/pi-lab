import { fileURLToPath } from "node:url";

import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext, type RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";

import { BookingRepository } from "./booking-repository.js";
import { createBookingRuntime, type ModelSelection, openHarness } from "./create-harness.js";
import { type CaseRunEvidence, type CheckResult, runDeterministicChecks, type ToolCallRecord } from "./deterministic-checks.js";
import type { EvaluationCase } from "./evaluation-cases.js";
import { answerTextOf, toolCallsFromEntries } from "./evidence.js";
import { attachTelemetry } from "./harness-telemetry.js";
import { attachTraceLogger, type TraceWriter } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { listEntries } from "./transcript.js";

export interface CaseRunResult {
  caseId: string;
  repetition: number;
  sessionId: string;
  prompt: string;
  answerText: string;
  /** `done`, or `unanswered:<reason>`. */
  operationStatus: string;
  /**
   * Wall-clock milliseconds measured by this runner around submit-and-wait — process-level timing that
   * includes tool execution and storage commits. The deterministic `latency` check instead reports the
   * providers' own `durationMs` read off the `lab.ai.request` spans.
   */
  wallClockMs: number;
  checks: CheckResult[];
  spans: RecordedTelemetrySpan[];
  toolCalls: ToolCallRecord[];
  telemetryWarnings: readonly string[];
}

export interface RunFrozenCasesOptions {
  cases: readonly EvaluationCase[];
  repetitions: number;
  models: Models;
  selection: ModelSelection;
  sessionsRoot: string;
  context?: Context;
  /** When set, every run attaches the human trace logger (tagged `<caseId>#<repetition>`) and writes here. */
  trace?: TraceWriter;
  onCaseComplete?: (result: CaseRunResult) => void;
}

export function expectedSpanKindsFor(evaluationCase: EvaluationCase): string[] {
  const kinds = ["lab.run", "lab.turn", "lab.ai.request"];
  if (evaluationCase.requiredEvidence.length > 0 || evaluationCase.expectedEffects.length > 0) {
    kinds.push("lab.tool");
  }
  return kinds;
}

/**
 * Runs every case `options.repetitions` times against a *fresh* `BookingRepository` and a fresh storage per run
 * (never sharing mutated fixture state across repetitions — `status-change` mutates BK1002, so reusing a
 * repository would make the second repetition's "expected effect" check meaningless). Each run gets its own
 * `InMemoryTelemetryContext`; nothing is shared across runs or cases.
 *
 * Order matters at the end of a run: `submission.wait()` returning does NOT mean the event stream has been
 * consumed (it is asynchronous and commit-derived). The run waits for the terminal `submission` event, stops
 * the streams, then flushes two microtasks — `InMemoryTelemetryContext` only marks a span `settled` one
 * microtask after its callback promise resolves (`pi-telemetry/dist/memory.js:116-122`) — and only then reads
 * `getSpans()`.
 */
export async function runFrozenCases(options: RunFrozenCasesOptions): Promise<CaseRunResult[]> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const results: CaseRunResult[] = [];

  for (const evaluationCase of options.cases) {
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
      const sessionId = `${evaluationCase.id}-rep${repetition}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { storage } = await openSessionStorage(options.sessionsRoot, sessionId, context);
      const runtime = createBookingRuntime(BookingRepository.fromDefaultFixture());
      const { harness, root } = await openHarness(
        storage,
        { models: options.models, selection: options.selection, registry: runtime.registry },
        context,
      );

      const telemetry = new InMemoryTelemetryContext();
      const telemetryHandle = await attachTelemetry(harness, root.id, { telemetry, toolReplayByName: runtime.toolReplayByName }, context);
      const trace = options.trace
        ? await attachTraceLogger(harness, root.id, options.trace, context, { tag: `${evaluationCase.id}#${repetition}` })
        : undefined;

      const startedAt = Date.now();
      const submission = await root.submit({ type: "input", content: evaluationCase.prompt }, context);
      const settled = await submission.wait(context);
      const wallClockMs = Date.now() - startedAt;

      await telemetryHandle.settled(settled.id);
      await trace?.settled(settled.id);
      await telemetryHandle.stop();
      await trace?.stop();
      await Promise.resolve();
      await Promise.resolve();

      const entries = await listEntries(root, context);
      await harness.close(context);

      const operationStatus = settled.status === "done" ? "done" : `${settled.status}${settled.reason ? `:${settled.reason}` : ""}`;
      const evidence: CaseRunEvidence = {
        answerText: settled.status === "done" ? answerTextOf(entries, settled.answer) : "",
        operationStatus,
        toolCalls: toolCallsFromEntries(entries),
        spans: telemetry.getSpans() as RecordedTelemetrySpan[],
      };

      const result: CaseRunResult = {
        caseId: evaluationCase.id,
        repetition,
        sessionId,
        prompt: evaluationCase.prompt,
        answerText: evidence.answerText,
        operationStatus,
        wallClockMs,
        checks: runDeterministicChecks(evaluationCase, evidence, expectedSpanKindsFor(evaluationCase)),
        spans: [...evidence.spans],
        toolCalls: [...evidence.toolCalls],
        telemetryWarnings: [...telemetryHandle.bridge.warnings],
      };
      results.push(result);
      options.onCaseComplete?.(result);
    }
  }

  return results;
}

export function defaultSessionsRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL("../session-data", importMetaUrl));
}
