import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";

import type { LookupDetails } from "./booking-tool.js";
import type { BudgetDimension } from "./connector/errors.js";
import { AttemptTrace, type AttemptRecord } from "./connector/trace.js";
import { createRequestRegistry, DEFAULT_MODEL_CALL, offeredToolNames, openHarness, type Capabilities, type ModelBinding, type ModelCallConfig, type RunState } from "./create-harness.js";
import { attachTraceLogger, type TraceHandle, type TraceWriter } from "./harness-trace-logger.js";
import { RunBudget, DEFAULT_LIMITS, type BudgetLimits, type BudgetUsage } from "./run-budget.js";
import { messageText } from "./transcript.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import type { SessionAccessService } from "./session-access.js";
import { UsageMeter, type Pricing, type UsageReport } from "./usage-meter.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

/** Owned by the transport: `cancel` aborts when the client goes away. */
export interface ChatControl {
  cancel: AbortSignal;
}

/**
 * How much of what was asked the data actually covers — decided from the structured lookup outcomes,
 * never from the model's prose.
 * - `complete`: every lookup returned everything.
 * - `partial`: some data is missing (an incomplete listing, or one lookup failed while another worked).
 * - `unavailable`: every lookup failed.
 * - `no_result`: the bookings asked about do not exist for this organization.
 * - `none`: no lookup was made.
 */
export type Completeness = "complete" | "partial" | "unavailable" | "no_result" | "none";

export type IncompleteCause =
  | { kind: "budget"; dimension: BudgetDimension }
  | { kind: "run_deadline" }
  | { kind: "output_limit" };

export interface ChatResult {
  requestId: string;
  sessionId: string;
  /** `incomplete`: the run stopped at a limit before the model finished. `answer` is then application-written. */
  status: "completed" | "incomplete";
  answer: string;
  incomplete?: IncompleteCause;
  capabilities: string[];
  data: { completeness: Completeness; stale: boolean; lookups: LookupDetails[] };
  budget: { limits: BudgetLimits; usage: BudgetUsage; exhausted: BudgetDimension[] };
  usage: UsageReport;
  /** Every HTTP attempt made for this request, correlated by request ID, tool-call ID, and operation ID. */
  connector: { attempts: AttemptRecord[] };
}

/**
 * A run that produced no result to return. `cancelled`: the client left. `run_failed`: the runtime or
 * the model provider failed; `detail` is for the server log, `code` is safe to show.
 */
export class ChatRunError extends Error {
  public constructor(
    public readonly code: "run_failed" | "cancelled",
    public readonly detail: string,
  ) {
    super(code);
    this.name = "ChatRunError";
  }
}

export interface ChatServiceOptions {
  sessions: SessionAccessService;
  binding: ModelBinding;
  capabilities: Capabilities;
  limits?: BudgetLimits;
  pricing?: Pricing;
  modelCall?: ModelCallConfig;
  /** When set, every request's committed events are rendered as a trace tree through it. */
  trace?: TraceWriter;
  /** Receives hook/task failures the harness swallowed. */
  onReport?: (error: unknown) => void;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} <- ${cause.message}` : error.message;
}

export function completenessOf(lookups: readonly LookupDetails[]): Completeness {
  if (lookups.length === 0) return "none";
  if (lookups.every((lookup) => lookup.outcome === "complete")) return "complete";
  if (lookups.every((lookup) => lookup.outcome === "not_found")) return "no_result";
  if (lookups.every((lookup) => lookup.outcome === "failed")) return "unavailable";
  if (lookups.every((lookup) => lookup.outcome === "complete" || lookup.outcome === "not_found")) return "complete";
  return "partial";
}

function describeLookup(lookup: LookupDetails): string {
  switch (lookup.outcome) {
    case "complete":
      return `${lookup.bookingNo}: complete (${lookup.containersRetrieved} containers)`;
    case "partial":
      return `${lookup.bookingNo}: PARTIAL (${lookup.containersRetrieved} of ${lookup.containersExpected} containers retrieved; no total available)`;
    case "not_found":
      return `${lookup.bookingNo}: not found`;
    case "failed":
      return `${lookup.bookingNo}: FAILED (${lookup.failure?.category ?? "unknown"} after ${lookup.failure?.attempts ?? 0} attempt(s))`;
  }
}

const DIMENSION_NAME: Record<BudgetDimension, string> = {
  turns: "turn",
  tool_calls: "tool-call",
  pages: "page",
  connector_attempts: "connector-attempt",
  context: "context-size",
  output: "response-length",
  run_deadline: "time",
};

function describeCause(cause: IncompleteCause): string {
  switch (cause.kind) {
    case "budget":
      // The context limit counts the whole session's history, not just this request: a long session stays over it, and only a new session recovers.
      if (cause.dimension === "context") return "the conversation reached its size limit (the whole session history counts, so this session will keep hitting it — start a new session)";
      return `it reached this request's ${DIMENSION_NAME[cause.dimension]} limit`;
    case "run_deadline":
      return "it ran out of the time allowed for one request";
    case "output_limit":
      return "the answer was cut off at the response length limit";
  }
}

/**
 * The application's own statement about the result, appended to (or replacing) the model's answer.
 * It exists because a model can be asked to be honest about partial data but cannot be *made* to be:
 * the note is generated from structured outcomes, so it is present whether or not the prose mentions them.
 */
export function applicationNote(input: { status: "completed" | "incomplete"; cause?: IncompleteCause; completeness: Completeness; stale: boolean; lookups: readonly LookupDetails[]; refused: readonly BudgetDimension[] }): string | undefined {
  const lines: string[] = [];
  if (input.status === "incomplete" && input.cause) lines.push(`This request did not finish: ${describeCause(input.cause)}.`);
  if (input.completeness === "partial" || input.completeness === "unavailable") lines.push("The data below is incomplete or could not be retrieved; treat any figure as unconfirmed.");
  if (input.stale) lines.push("At least one record may be out of date.");
  if (input.refused.length > 0) lines.push(`Some calls were refused by request limits (${input.refused.map((dimension) => DIMENSION_NAME[dimension]).join(", ")}).`);
  if (lines.length === 0) return undefined;
  if (input.lookups.length > 0) lines.push(`Lookups: ${input.lookups.map(describeLookup).join("; ")}.`);
  return `[Application note] ${lines.join(" ")}`;
}

type Stopped = "client_cancelled" | "run_deadline" | "budget";

export class ChatService {
  private readonly queues = new Map<string, Promise<unknown>>();

  public constructor(private readonly options: ChatServiceOptions) {}

  /**
   * Two requests on one session must not overlap: each would open its own storage handle over the same
   * files, read the history as it was, and append to it, forking the conversation while both answered 200
   * (Lab 18, finding 7). The global admission queue bounds *load*; this one orders *writers*.
   */
  private serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return next;
  }

  public async chat(security: SecurityContext, request: ChatRequest, control: ChatControl, runtime: Context = BACKGROUND_CONTEXT): Promise<ChatResult> {
    assertSecurityContext(security);
    if (control.cancel.aborted) throw new ChatRunError("cancelled", "cancelled before the run started");
    // The registry decides first, so a denied session costs no storage read; the storage is opened inside the queue.
    const resolved = this.options.sessions.resolve(security, request.sessionId);
    return this.serialized(resolved.sessionId, () => this.run(security, request, resolved.sessionId, resolved, control, runtime));
  }

  private async run(
    security: SecurityContext,
    request: ChatRequest,
    sessionId: string,
    resolved: ReturnType<SessionAccessService["resolve"]>,
    control: ChatControl,
    runtime: Context,
  ): Promise<ChatResult> {
    if (control.cancel.aborted) throw new ChatRunError("cancelled", "cancelled while waiting behind another run on this session");
    const limits = this.options.limits ?? DEFAULT_LIMITS;
    const run: RunState = { budget: new RunBudget(limits), trace: new AttemptTrace(), meter: new UsageMeter(this.options.pricing), lookups: [], stopForBudget: () => undefined };
    const toolNames = offeredToolNames(security, this.options.capabilities.directory);
    const { storage } = await this.options.sessions.openStorage(resolved, runtime);

    try {
      const requestRegistry = createRequestRegistry(security, this.options.capabilities, run);
      const { harness, root, inspection, offered } = await openHarness(
        storage,
        { binding: this.options.binding, requestRegistry, toolNames, maxOutputTokens: limits.maxOutputTokens, modelCall: this.options.modelCall ?? DEFAULT_MODEL_CALL, onReport: this.options.onReport },
        runtime,
      );
      // Attached inside the `try` below: if attaching throws, the harness must still be closed.
      let trace: TraceHandle | undefined;

      // Who stopped the run is the application's own record: a budget, the deadline, and a client leaving
      // all settle the same way (`unanswered`, reason `aborted`).
      let stopped: Stopped | undefined;
      const stop = (reason: Stopped): void => {
        if (stopped !== undefined) return;
        stopped = reason;
        // Fire-and-forget: from inside a hook, awaiting the abort would wait for the very task the hook runs in.
        void root.abort(runtime).catch(() => undefined);
      };
      run.stopForBudget = () => stop("budget");
      // Cancellation goes through `root.abort()`, never through a cancellable Context handed to `wait()`:
      // a cancelled wait only stops *waiting*; the run carries on (tests/sdk-assumptions.test.ts).
      const onClientGone = (): void => stop("client_cancelled");
      control.cancel.addEventListener("abort", onClientGone, { once: true });
      const deadlineTimer = setTimeout(() => stop("run_deadline"), Math.ceil(run.budget.deadline.remainingMs()));
      // Idempotent. Called as soon as the run settles, so a disconnect or deadline landing during the
      // reads below cannot abort a conversation whose operation is already over.
      const disarm = (): void => {
        clearTimeout(deadlineTimer);
        control.cancel.removeEventListener("abort", onClientGone);
      };

      try {
        trace = this.options.trace
          ? await attachTraceLogger(harness, root.id, this.options.trace, runtime, { tag: `req=${security.requestId.slice(0, 8)} ${security.tenantId}/${security.subject}`, attemptsFor: (id) => run.trace.forToolCall(id) })
          : undefined;
        if (inspection.submissions.length > 0) {
          // A new request would be scheduled together with the old work and run it under *this* request's budget.
          throw new ChatRunError("run_failed", `session ${sessionId} has ${inspection.submissions.length} unsettled submission(s) from an earlier run; refusing to run new work behind them`);
        }
        if (control.cancel.aborted) throw new ChatRunError("cancelled", "cancelled before the run started");

        let settled;
        try {
          const submission = await root.submit({ type: "input", content: request.message }, runtime);
          if (stopped !== undefined) await root.abort(runtime); // a stop that landed before the input was placed
          settled = await submission.wait(runtime);
        } catch (error) {
          throw new ChatRunError("run_failed", describeError(error));
        }
        disarm();
        await trace?.settled(settled.id);
        // A budget stop is reported even when the run still settled `done` (see below); a deadline or disconnect that landed
        // just as the run finished changed nothing, so it is not.
        if (stopped !== undefined && (settled.status === "unanswered" || stopped === "budget")) trace?.note(`stopped: ${stopped}${stopped === "budget" ? ` (${run.budget.exhaustedDimensions().join(", ")})` : ""}`);

        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") {
            if (stopped === "run_deadline") return this.finish(security, sessionId, offered, run, { status: "incomplete", cause: { kind: "run_deadline" }, modelAnswer: "" });
            if (stopped === "budget") {
              const dimension = run.budget.isExhausted("context") ? "context" : "turns";
              return this.finish(security, sessionId, offered, run, { status: "incomplete", cause: { kind: "budget", dimension }, modelAnswer: "" });
            }
            throw new ChatRunError("cancelled", "the client went away while the run was in progress");
          }
          // A provider failure after the harness's own retries: a failed run, never an answer.
          throw new ChatRunError("run_failed", `provider error: reason=${settled.reason}${settled.detail === undefined ? "" : ` detail=${JSON.stringify(settled.detail)}`}`);
        }
        if (settled.status !== "done" || settled.type !== "input") throw new ChatRunError("run_failed", `submission status=${settled.status}`);
        // The abort can lose its race with the request (README, "Budgets"): the model then answers the withheld
        // placeholder and the run settles `done`. That answer is to nothing the user asked, so it is dropped.
        // Defensive: not reproduced in testing, hence not covered by a test.
        if (stopped === "budget") {
          const dimension = run.budget.isExhausted("context") ? "context" : "turns";
          return this.finish(security, sessionId, offered, run, { status: "incomplete", cause: { kind: "budget", dimension }, modelAnswer: "" });
        }

        const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), runtime);
        const message = entry?.model?.[0];
        if (message?.role !== "assistant") throw new ChatRunError("run_failed", "no assistant answer at the submission's answer entry");
        if (message.errorMessage) throw new ChatRunError("run_failed", `assistant answer failed: ${message.errorMessage}`);
        const modelAnswer = messageText(message);
        // Pi settles a response cut off at the output limit as `done` with the fragment as the answer; the real
        // reason survives only in `afterResponse`, which marked the budget. Here it is a bounded, reportable stop.
        if (run.budget.isExhausted("output")) return this.finish(security, sessionId, offered, run, { status: "incomplete", cause: { kind: "output_limit" }, modelAnswer });
        if (modelAnswer === "") throw new ChatRunError("run_failed", "no assistant text at the submission's answer entry");
        return this.finish(security, sessionId, offered, run, { status: "completed", modelAnswer });
      } finally {
        disarm();
        await trace?.stop().catch(() => undefined);
        // A failed cleanup is not worth discarding a finished result.
        await harness.close(runtime).catch(() => undefined);
      }
    } finally {
      await storage.close(runtime).catch(() => undefined);
    }
  }

  private finish(
    security: SecurityContext,
    sessionId: string,
    toolNames: string[],
    run: RunState,
    outcome: { status: "completed" | "incomplete"; cause?: IncompleteCause; modelAnswer: string },
  ): ChatResult {
    const completeness = completenessOf(run.lookups);
    const stale = run.lookups.some((lookup) => lookup.stale);
    // Refusals by a per-call limit are worth naming even in a completed run; turn/context/output/deadline stops are the `cause`.
    const refused = run.budget.exhaustedDimensions().filter((dimension) => dimension === "tool_calls" || dimension === "pages" || dimension === "connector_attempts");
    const note = applicationNote({ status: outcome.status, cause: outcome.cause, completeness, stale, lookups: run.lookups, refused });
    const answer = [outcome.modelAnswer.trim(), note].filter((part): part is string => part !== undefined && part !== "").join("\n\n");
    return {
      requestId: security.requestId,
      sessionId,
      status: outcome.status,
      answer: answer === "" ? "No answer was produced." : answer,
      ...(outcome.cause === undefined ? {} : { incomplete: outcome.cause }),
      capabilities: toolNames,
      data: { completeness, stale, lookups: run.lookups },
      budget: { limits: run.budget.limits, usage: { ...run.budget.usage }, exhausted: run.budget.exhaustedDimensions() },
      usage: run.meter.report(),
      connector: { attempts: run.trace.records },
    };
  }
}
