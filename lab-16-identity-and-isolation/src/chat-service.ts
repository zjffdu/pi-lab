import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

import type { Booking, TenantBookingStore } from "./booking-store.js";
import { createRequestRegistry, openHarness, type ModelBinding } from "./create-harness.js";
import { attachTraceLogger, type TraceWriter } from "./harness-trace-logger.js";
import { findForeignMarkers } from "./output-guard.js";
import { createProviderBoundary } from "./provider-boundary.js";
import type { ScopedCache } from "./scoped-cache.js";
import type { SessionAccessService } from "./session-access.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import { listEntries, messageText } from "./transcript.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

export interface ChatResult {
  requestId: string;
  sessionId: string;
  answer: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** A run that did not produce a trustworthy answer. `code` is safe to show a client; `detail` is for the server log. */
export class ChatRunError extends Error {
  public constructor(
    public readonly code: "run_failed" | "output_scope_violation",
    public readonly detail: string,
  ) {
    super(code);
    this.name = "ChatRunError";
  }
}

export interface ChatServiceOptions {
  sessions: SessionAccessService;
  binding: ModelBinding;
  store: TenantBookingStore;
  cache: ScopedCache<Booking>;
  /** Where the per-request trace goes. Omit for no trace. Lines carry `req=`/`tenant=`/`sub=` and never a token. */
  trace?: TraceWriter;
  /** `"full"` prints message text in the trace; the default prints only its length. See `TraceOptions.text`. */
  traceText?: "redacted" | "full";
  /** Hook failures the harness swallowed (it would otherwise drop them silently). */
  onReport?: (error: unknown) => void;
}

/** What the harness's own `entry.model` holds, flattened to searchable text. */
function entryText(entry: EntryRecord): string {
  return entry.model === undefined ? "" : JSON.stringify(entry.model);
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  return message?.role === "assistant" ? messageText(message) : "";
}

/**
 * The application seam between an authenticated request and the Pi runtime. It receives a
 * `SecurityContext`, never raw headers, so nothing here can re-derive identity from anything a client
 * controls. Order matters and is the point: the session is resolved against the registry *before* a
 * harness (and therefore any model call) exists.
 *
 * Foreign-tenant text is handled in two different ways, because Pi 1.1 cannot stop a request from inside
 * a hook (a `beforeRequest` hook that throws is reported and the request is still sent):
 *
 * 1. **Pre-flight, before `submit()`.** The new input and everything already stored in the conversation
 *    are scanned. A hit fails the request with no provider call, and the input is never stored. This is
 *    the only check that can prevent a request.
 * 2. **In-run recorder.** `provider-boundary.ts` sees every request that is actually sent and records a
 *    violation; after the run the answer is withheld. By then the provider has already received it.
 */
export class ChatService {
  public constructor(private readonly options: ChatServiceOptions) {}

  private async openRoot(security: SecurityContext, sessionId: string | undefined, runtime: Context) {
    const { sessionId: id, storage } = await this.options.sessions.open(security, sessionId, runtime);
    const boundary = createProviderBoundary();
    boundary.forbid(...this.options.store.foreignMarkers(security));
    try {
      const requestRegistry = createRequestRegistry({
        securityContext: security,
        store: this.options.store,
        cache: this.options.cache,
        boundary,
      });
      const { harness, root } = await openHarness(
        storage,
        { binding: this.options.binding, requestRegistry, onReport: this.options.onReport },
        runtime,
      );
      return { sessionId: id, harness, root, boundary };
    } catch (error) {
      await storage.close(withoutAbortSignal(runtime));
      throw error;
    }
  }

  public async chat(security: SecurityContext, request: ChatRequest, runtime: Context): Promise<ChatResult> {
    assertSecurityContext(security);
    const { sessionId, harness, root, boundary } = await this.openRoot(security, request.sessionId, runtime);

    try {
      const markers = this.options.store.foreignMarkers(security);
      const before = await listEntries(root, runtime);
      const storedLeaks = before.filter((entry) => findForeignMarkers(entryText(entry), markers).length > 0);
      if (storedLeaks.length > 0) {
        throw new ChatRunError("run_failed", `pre-flight: ${storedLeaks.length} stored entr(y/ies) contain foreign markers`);
      }
      if (findForeignMarkers(request.message, markers).length > 0) {
        throw new ChatRunError("run_failed", "pre-flight: the input contains a foreign marker");
      }

      const trace = this.options.trace
        ? await attachTraceLogger(harness, root.id, this.options.trace, runtime, {
            tag: `req=${security.requestId.slice(0, 8)} tenant=${security.tenantId} sub=${security.subject}`,
            text: this.options.traceText,
          })
        : undefined;

      // A recorded violation outranks any other way the run can fail: the provider already received the
      // foreign text, and a log that only said "unanswered" would hide that.
      const scopeViolation = (alsoFailed?: string) =>
        new ChatRunError(
          "output_scope_violation",
          `provider-boundary recorded ${boundary.violations.length} violation(s) after the request was sent` +
            (alsoFailed === undefined ? "" : `; the run also failed: ${alsoFailed}`),
        );

      let settled;
      try {
        const submission = await root.submit({ type: "input", content: request.message }, runtime);
        settled = await submission.wait(runtime);
        await trace?.settled(settled.id);
      } catch (error) {
        if (boundary.violations.length > 0) throw scopeViolation(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        await trace?.stop();
      }
      if (boundary.violations.length > 0) {
        throw scopeViolation(settled.status === "done" ? undefined : `submission status=${settled.status}`);
      }

      // `done` carries the id of the entry that answered this input. A run that failed (`unanswered`) has
      // no such entry, so an earlier turn's answer can never be returned for it.
      if (settled.status !== "done") throw new ChatRunError("run_failed", `submission status=${settled.status}`);
      const answerEntry = (await listEntries(root, runtime)).find((entry) => entry.id === settled.answer);
      const answer = assistantText(answerEntry);
      if (answer === "") throw new ChatRunError("run_failed", "the answering entry has no text");

      const leaks = findForeignMarkers(answer, markers);
      if (leaks.length > 0) throw new ChatRunError("output_scope_violation", `answer contained ${leaks.length} foreign marker(s)`);

      return { requestId: security.requestId, sessionId, answer };
    } finally {
      // Cleanup must finish even when the caller was cancelled, and an error thrown from `finally` would
      // replace the failure that is actually being reported (a recorded violation, for one).
      await harness.close(withoutAbortSignal(runtime));
    }
  }

  public async history(security: SecurityContext, sessionId: string, runtime: Context): Promise<HistoryMessage[]> {
    assertSecurityContext(security);
    const { harness, root } = await this.openRoot(security, sessionId, runtime);
    try {
      return await historyOf(root, runtime);
    } finally {
      await harness.close(withoutAbortSignal(runtime));
    }
  }
}

async function historyOf(root: Conversation, runtime: Context): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  for (const entry of await listEntries(root, runtime)) {
    const message = entry.model?.[0];
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = messageText(message);
    if (text !== "") messages.push({ role: message.role, text });
  }
  return messages;
}
