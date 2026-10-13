import type { Context } from "@earendil-works/chord";
import { AssistantEntry } from "@earendil-works/pi-durable";

import type { ActionService } from "./action-service.js";
import { createRequestRegistry, openHarness, type ModelBinding } from "./create-harness.js";
import { attachTraceLogger, type TraceWriter } from "./harness-trace-logger.js";
import type { ProposalDetails } from "./propose-tool.js";
import type { SessionAccessService } from "./session-access.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import { messageText } from "./transcript.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

/** What the run produced. `proposals` are pending actions created by this request — never effects. */
export interface ChatResult {
  requestId: string;
  sessionId: string;
  answer: string;
  proposals: ProposalDetails[];
}

/** A run that did not produce a trustworthy answer. `code` is safe to show a client; `detail` is for the server log. */
export class ChatRunError extends Error {
  public constructor(
    public readonly code: "run_failed",
    public readonly detail: string,
  ) {
    super(code);
    this.name = "ChatRunError";
  }
}

export interface ChatServiceOptions {
  sessions: SessionAccessService;
  binding: ModelBinding;
  actions: ActionService;
  /**
   * Receives one indented run/turn/tool trace line per committed event, tagged with the request id,
   * tenant, and subject so concurrent requests stay distinguishable. Off by default.
   */
  trace?: TraceWriter;
  /** Receives hook failures the harness swallowed instead of failing the call. */
  onReport?: (error: unknown) => void;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} <- ${cause.message}` : error.message;
}

/**
 * Authenticated request → session resolved against the registry → harness → answer. The registry is
 * consulted *before* a harness (and therefore any model call) exists.
 *
 * pi-durable does no locking, and a conversation is busy while a run is going, so two requests on the
 * same session are queued here, one run at a time, rather than left to collide in the storage.
 */
export class ChatService {
  private readonly queues = new Map<string, Promise<unknown>>();

  public constructor(private readonly options: ChatServiceOptions) {}

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

  public async chat(security: SecurityContext, request: ChatRequest, runtime: Context): Promise<ChatResult> {
    assertSecurityContext(security);
    const resolved = this.options.sessions.resolve(security, request.sessionId);
    const { sessionId } = resolved;

    return this.serialized(sessionId, async () => {
      // Opened inside the queue: a storage reads its entries when it is opened, so opening it before
      // waiting would run this request against the history as it was before the earlier run finished.
      const { storage } = await this.options.sessions.openStorage(resolved, runtime);
      const proposals: ProposalDetails[] = [];
      const requestRegistry = createRequestRegistry({
        securityContext: security,
        actions: this.options.actions,
        sessionId,
        onProposal: (details) => proposals.push(details),
      });
      const { harness, root } = await openHarness(storage, { binding: this.options.binding, requestRegistry, onReport: this.options.onReport }, runtime);

      try {
        const trace = this.options.trace
          ? await attachTraceLogger(harness, root.id, this.options.trace, runtime, { tag: `req=${security.requestId.slice(0, 8)} ${security.tenantId}/${security.subject}` })
          : undefined;
        try {
          let settled;
          try {
            settled = await (await root.submit({ type: "input", content: request.message }, runtime)).wait(runtime);
          } catch (error) {
            throw new ChatRunError("run_failed", describeError(error));
          }
          await trace?.settled(settled.id);

          if (settled.status !== "done" || settled.type !== "input") {
            const why = settled.status === "unanswered" ? ` reason=${settled.reason}${settled.detail === undefined ? "" : ` detail=${JSON.stringify(settled.detail)}`}` : "";
            throw new ChatRunError("run_failed", `submission status=${settled.status}${why}`);
          }
          const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), runtime);
          const message = entry?.model?.[0];
          if (message?.role !== "assistant" || message.errorMessage) {
            throw new ChatRunError("run_failed", `assistant answer ${message?.role === "assistant" ? `failed: ${message.errorMessage}` : "missing"}`);
          }
          const answer = messageText(message);
          if (answer === "") throw new ChatRunError("run_failed", "no assistant answer text");
          return { requestId: security.requestId, sessionId, answer, proposals };
        } finally {
          await trace?.stop();
        }
      } finally {
        await harness.close(runtime);
      }
    });
  }
}
