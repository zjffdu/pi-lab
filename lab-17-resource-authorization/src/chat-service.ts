import type { Context } from "@earendil-works/chord";
import type { Conversation, Harness, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";

import type { AuditLog } from "./audit-log.js";
import type { BookingService } from "./booking-service.js";
import { resolveCapabilities } from "./capability-resolver.js";
import { createBookingRegistry, openHarness, type ModelBinding } from "./create-harness.js";
import type { PermissionDirectory } from "./directory.js";
import type { SessionAccessService } from "./session-access.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import { attachTraceLogger, type TraceWriter } from "./harness-trace-logger.js";
import { listEntries, messageText } from "./transcript.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

export interface ChatResult {
  requestId: string;
  sessionId: string;
  answer: string;
  /** The tools the model was offered for this operation, from today's roles. */
  offeredTools: string[];
  /** The offer the reopened conversation had *stored* before this operation replaced it — yesterday's list, not a grant. */
  restoredOffer: string[];
}

/** The caller holds no role that grants any capability; refused before a session or model is touched. */
export class ChatAccessDeniedError extends Error {
  public constructor() {
    super("forbidden");
    this.name = "ChatAccessDeniedError";
  }
}

/** A run that did not produce a trustworthy answer. `detail` is for the server log only. */
export class ChatRunError extends Error {
  public constructor(public readonly detail: string) {
    super("run_failed");
    this.name = "ChatRunError";
  }
}

export interface ChatServiceOptions {
  sessions: SessionAccessService;
  binding: ModelBinding;
  directory: PermissionDirectory;
  audit: AuditLog;
  bookings: BookingService;
  /** When set, every operation's committed events are rendered as a trace tree through it. */
  trace?: TraceWriter;
  onReport?: (error: unknown) => void;
}

type Mode = { kind: "prompt"; message: string } | { kind: "resume" };

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} <- ${cause.message}` : error.message;
}

/**
 * The seam between an authenticated request and the Pi runtime. Per operation, in this order:
 * resolve today's capabilities from the server-side directory (refusing before anything else if there
 * are none), resolve the session against the tenant/owner registry, open the harness, and *overwrite*
 * the conversation's stored tool offer with today's list. Only then is any model call or recovered
 * task allowed to run. Resource-level authorization is not repeated here; it happens in
 * `BookingService` on every tool execution.
 */
export class ChatService {
  public constructor(private readonly options: ChatServiceOptions) {}

  public chat(security: SecurityContext, request: ChatRequest, runtime: Context): Promise<ChatResult> {
    return this.run(security, request.sessionId, { kind: "prompt", message: request.message }, runtime);
  }

  /** Continue a session whose last run was interrupted, under today's permissions. */
  public resume(security: SecurityContext, sessionId: string, runtime: Context): Promise<ChatResult> {
    return this.run(security, sessionId, { kind: "resume" }, runtime);
  }

  private async run(security: SecurityContext, sessionId: string | undefined, mode: Mode, runtime: Context): Promise<ChatResult> {
    assertSecurityContext(security);
    const capabilities = await resolveCapabilities(security, this.options.directory, this.options.audit);
    if (capabilities.offeredToolNames.length === 0) throw new ChatAccessDeniedError();

    const opened = await this.options.sessions.open(security, sessionId, runtime);
    try {
      const booking = createBookingRegistry({ security, bookings: this.options.bookings });
      const { harness, root, inspection, restoredOffer } = await openHarness(
        opened.storage,
        { binding: this.options.binding, booking, offeredToolNames: capabilities.offeredToolNames, onReport: this.options.onReport },
        runtime,
      );

      const trace = this.options.trace ? await attachTraceLogger(harness, root.id, this.options.trace, runtime) : undefined;
      try {
        const settled = await this.drive(harness, root, inspection.submissions, mode, trace, runtime);
        const answer = await answerOf(root, settled, runtime);
        return { requestId: security.requestId, sessionId: opened.sessionId, answer, offeredTools: capabilities.offeredToolNames, restoredOffer };
      } finally {
        await trace?.stop();
        await harness.close(runtime);
      }
    } finally {
      // Idempotent, and safe whether or not a harness was ever attached: closing the harness is not what closes storage.
      await opened.storage.close(runtime);
    }
  }

  private async drive(
    harness: Harness,
    root: Conversation,
    unsettled: readonly SubmissionRecord[],
    mode: Mode,
    trace: { settled(id: SubmissionId): Promise<void> } | undefined,
    runtime: Context,
  ): Promise<SubmissionRecord> {
    let submissionId: SubmissionId;
    if (mode.kind === "prompt") {
      try {
        submissionId = (await root.submit({ type: "input", content: mode.message }, runtime)).id;
      } catch (error) {
        throw new ChatRunError(describeError(error));
      }
    } else {
      const [first] = unsettled;
      if (!first || unsettled.length > 1) throw new ChatRunError(`expected exactly one unsettled submission to resume, found ${unsettled.length}`);
      submissionId = first.id;
      harness.resume();
    }

    try {
      const submission = await harness.submission(submissionId, runtime);
      if (!submission) throw new Error(`submission ${submissionId} cannot be reacquired`);
      const settled = await submission.wait(runtime);
      await trace?.settled(settled.id);
      return settled;
    } catch (error) {
      throw new ChatRunError(describeError(error));
    }
  }
}

/** The final assistant text of a settled submission, or a `run_failed` if the run did not produce one. */
async function answerOf(root: Conversation, settled: SubmissionRecord, runtime: Context): Promise<string> {
  if (settled.status !== "done") throw new ChatRunError(`submission status=${settled.status}`);
  const answerId = "answer" in settled ? settled.answer : undefined;
  if (answerId === undefined) throw new ChatRunError("no assistant answer on the settled submission");
  const entry = (await listEntries(root, runtime)).find((candidate) => candidate.id === answerId);
  const message = entry?.model?.[0];
  const text = message?.role === "assistant" ? messageText(message) : "";
  if (text === "") throw new ChatRunError("no assistant answer text at the submission's answer entry");
  return text;
}
