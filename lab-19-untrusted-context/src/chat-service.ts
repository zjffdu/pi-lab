import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";

import { assessBranch, toEntryLike, type BranchAssessment } from "./context-provenance.js";
import { createRequestRegistry, openHarness, SUMMARY_INSTRUCTIONS, type Capabilities, type ModelBinding, type OpenHarnessOptions, type RequestRegistry } from "./create-harness.js";
import { containsValue, findForbiddenLabels } from "./egress-scan.js";
import { checkCitations, EvidenceCollector, extractCitations, type CitationCheck, type EvidenceSummary } from "./evidence.js";
import { attachTraceLogger, type TraceHandle, type TraceWriter } from "./harness-trace-logger.js";
import type { ProposalDetails } from "./propose-tool.js";
import { replaceValues, type BoundaryViolation } from "./provider-boundary.js";
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
  /** Tool names offered to the model for this request, from the caller's current roles. */
  capabilities: string[];
  evidence: EvidenceSummary;
  citations: CitationCheck & { verified: boolean };
  proposals: ProposalDetails[];
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  redacted?: true;
}

export const REDACTION_TEXT = "[removed: this content depended on a source you can no longer access]";

/**
 * A run that did not produce a trustworthy answer. `code` is safe to show a client; `detail` is for the
 * server log. `context_unsafe` means the stored conversation depends on a source the caller can no longer
 * read (or one whose provenance is unknown, or that holds a value that must not leave): it is refused
 * before any model call.
 */
export class ChatRunError extends Error {
  public constructor(
    public readonly code: "run_failed" | "output_scope_violation" | "context_unsafe",
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
  /** Compaction settings for the harness. Off unless a test or caller turns it on; the `beforeCompact` gate applies either way. */
  compaction?: OpenHarnessOptions["compaction"];
  /**
   * Receives one indented run/turn/tool trace line per committed event, tagged with the request id, tenant,
   * and subject so concurrent requests stay distinguishable. Off by default: a trace line carries user text
   * and tool arguments.
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

interface OpenedRequest {
  harness: Harness;
  registry: RequestRegistry;
  root: Conversation;
  close: () => Promise<void>;
  trace: TraceHandle | undefined;
  boundary: BoundaryViolation[];
  gate: Array<{ tool: string; labels: readonly string[] }>;
  evidence: EvidenceCollector;
  proposals: ProposalDetails[];
}

/**
 * Authenticated request → session resolved against the registry → harness → checks around the run. The
 * registry is consulted *before* a harness (and therefore any model call) exists.
 *
 * pi-durable does no locking, and a conversation is busy while a run is going, so every operation on one
 * session — chat, compact, and history — is queued here, one at a time. Two harnesses over one storage
 * gave two user messages the same entry id and forked the history (Lab 18), and a storage reads its entries
 * when it is opened, so each operation opens its storage *inside* the queue.
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

  private assess(security: SecurityContext, entries: Awaited<ReturnType<typeof listEntries>>): BranchAssessment {
    const forbidden = this.options.capabilities.documents.forbiddenValues(security);
    return assessBranch(
      entries.map(toEntryLike),
      (ref) => this.options.capabilities.documents.canReadRef(security, ref),
      (text) => forbidden.some((item) => containsValue(text, item.value)),
    );
  }

  /** Opens the storage and harness for one request. Must be called inside the session's queue. */
  private async open(security: SecurityContext, sessionId: string, resolved: Parameters<SessionAccessService["openStorage"]>[0], runtime: Context, mode: { applyOffer: boolean; traceTag: boolean }): Promise<OpenedRequest> {
    const { storage } = await this.options.sessions.openStorage(resolved, runtime);
    const boundary: BoundaryViolation[] = [];
    const gate: OpenedRequest["gate"] = [];
    const evidence = new EvidenceCollector();
    const proposals: ProposalDetails[] = [];
    let conversation: Conversation | undefined;
    let trace: TraceHandle | undefined;

    const registry = createRequestRegistry({
      security,
      capabilities: this.options.capabilities,
      callbacks: {
        onEvidence: (details) => evidence.record(details),
        onProposal: (details) => proposals.push(details),
        onGateViolation: (tool, labels) => {
          gate.push({ tool, labels });
          trace?.note(`⛔ write_gate_refused ${tool} labels=[${labels.join(",")}]`);
        },
        onBoundary: (violation) => {
          boundary.push(violation);
          trace?.note(
            violation.layer === "compaction"
              ? `⛔ compaction_declined reason=${violation.label}`
              : `⛔ egress_withheld ${violation.kind} ${violation.label} message_index=${violation.messageIndex}`,
          );
        },
      },
      assessConversation: async (context) => {
        if (conversation === undefined) return undefined;
        return this.assess(security, await listEntries(conversation, context));
      },
    });

    const { harness, root } = await openHarness(
      storage,
      { binding: this.options.binding, requestRegistry: registry, compaction: this.options.compaction, applyOffer: mode.applyOffer, onReport: this.options.onReport },
      runtime,
    );
    conversation = root;
    try {
      if (this.options.trace && mode.traceTag) {
        trace = await attachTraceLogger(harness, root.id, this.options.trace, runtime, {
          tag: `req=${security.requestId.slice(0, 8)} ${security.tenantId}/${security.subject}`,
          redact: (text) => replaceValues(text, this.options.capabilities.documents.forbiddenValues(security)),
        });
      }
    } catch (error) {
      await harness.close(runtime).catch(() => undefined);
      throw error;
    }
    return {
      harness,
      registry,
      root,
      trace,
      boundary,
      gate,
      evidence,
      proposals,
      close: async () => {
        await trace?.stop();
        await harness.close(runtime);
      },
    };
  }

  public async chat(security: SecurityContext, request: ChatRequest, runtime: Context): Promise<ChatResult> {
    assertSecurityContext(security);
    const resolved = this.options.sessions.resolve(security, request.sessionId);
    const { sessionId } = resolved;

    return this.serialized(sessionId, async () => {
      const opened = await this.open(security, sessionId, resolved, runtime, { applyOffer: true, traceTag: true });
      try {
        const { root, trace } = opened;
        const capabilities = this.options.capabilities;

        // Preflight — the layer that can *refuse*. Pi 1.1 offers no hook that stops a request, so
        // everything that must not reach the provider is checked here, before `submit()`.
        const before = this.assess(security, await listEntries(root, runtime));
        if (before.verdict !== "clean") {
          throw new ChatRunError("context_unsafe", `${before.verdict}: revoked=${before.revoked.length} unattributable=${before.unattributable.length} contaminated=${before.contaminated.length}`);
        }
        const promptLabels = findForbiddenLabels([request.message], capabilities.documents.forbiddenValues(security));
        if (promptLabels.length > 0) throw new ChatRunError("run_failed", `preflight: the prompt contains forbidden value(s): ${promptLabels.join(", ")}`);

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

        // A layer upstream of the guards failed during the run. The value never became durable (write gate)
        // or never reached the provider (withheld), but the run is not trustworthy, so it is reported as failed.
        if (opened.gate.length > 0) throw new ChatRunError("run_failed", `write gate refused a tool result: ${opened.gate.map((hit) => `${hit.tool}(${hit.labels.join(",")})`).join("; ")}`);
        const withheld = opened.boundary.filter((violation) => violation.layer === "request");
        if (withheld.length > 0) throw new ChatRunError("run_failed", `egress backstop withheld: ${withheld.map((violation) => `${violation.kind}(${violation.label})`).join("; ")}`);

        const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), runtime);
        const message = entry?.model?.[0];
        if (message?.role !== "assistant" || message.errorMessage) {
          throw new ChatRunError("run_failed", `assistant answer ${message?.role === "assistant" ? `failed: ${message.errorMessage}` : "missing"}`);
        }
        const answer = messageText(message);
        if (answer === "") throw new ChatRunError("run_failed", "no assistant answer text");

        const leaks = findForbiddenLabels([answer], capabilities.documents.forbiddenValues(security));
        if (leaks.length > 0) throw new ChatRunError("output_scope_violation", `answer contained forbidden value(s): ${leaks.join(", ")}`);

        // Access may have changed while the run was in flight: do not hand back an answer derived from a source that is now revoked.
        const after = this.assess(security, await listEntries(root, runtime));
        if (after.verdict !== "clean") throw new ChatRunError("context_unsafe", `${after.verdict} after run: revoked=${after.revoked.length} contaminated=${after.contaminated.length}`);

        const check = checkCitations(extractCitations(answer), after.refs, (ref) => capabilities.documents.canReadRef(security, ref));
        return {
          requestId: security.requestId,
          sessionId,
          answer,
          capabilities: opened.registry.offered,
          evidence: opened.evidence.summary(),
          citations: { ...check, verified: check.unresolved.length === 0 },
          proposals: opened.proposals,
        };
      } finally {
        await opened.close();
      }
    });
  }

  /**
   * Compaction is gated twice: this preflight refuses early with a clean error, and the `beforeCompact` hook
   * (installed on every conversation) declines manual, threshold, and overflow compactions alike. A
   * summarization request does not pass through `beforeRequest`, so the hook is the only layer between
   * session content and the summarizer.
   */
  public async compact(security: SecurityContext, sessionId: string, runtime: Context): Promise<{ compacted: boolean }> {
    assertSecurityContext(security);
    const resolved = this.options.sessions.resolve(security, sessionId);
    return this.serialized(resolved.sessionId, async () => {
      const opened = await this.open(security, resolved.sessionId, resolved, runtime, { applyOffer: true, traceTag: true });
      try {
        const before = this.assess(security, await listEntries(opened.root, runtime));
        if (before.verdict !== "clean") throw new ChatRunError("context_unsafe", `${before.verdict}: refused to summarize`);

        const taskId = await opened.root.compact(SUMMARY_INSTRUCTIONS, runtime);
        const harnessTask = await opened.harness.waitForTask(taskId, runtime);
        const outcome = harnessTask.state.outcome;
        if (opened.boundary.some((violation) => violation.layer === "compaction")) {
          throw new ChatRunError("context_unsafe", `compaction declined: ${opened.boundary.map((violation) => violation.label).join(", ")}`);
        }
        if (outcome.status !== "completed") throw new ChatRunError("run_failed", `compaction status=${outcome.status}`);
        const submissionId = outcome.result.submissionId;
        if (submissionId === undefined) return { compacted: false };
        const placed = await opened.harness.submission(submissionId, runtime);
        const record = await placed?.wait(runtime);
        return { compacted: record?.status === "done" };
      } finally {
        await opened.close();
      }
    });
  }

  /** History is a display path, so revoked-derived or contaminated content is *redacted* rather than refused; the user's own messages remain. */
  public async history(security: SecurityContext, sessionId: string, runtime: Context): Promise<HistoryMessage[]> {
    assertSecurityContext(security);
    const resolved = this.options.sessions.resolve(security, sessionId);
    return this.serialized(resolved.sessionId, async () => {
      // No offer is applied: reading a conversation must not write to it.
      const opened = await this.open(security, resolved.sessionId, resolved, runtime, { applyOffer: false, traceTag: false });
      try {
        const entries = await listEntries(opened.root, runtime);
        const { taintedEntryIds } = this.assess(security, entries);
        const messages: HistoryMessage[] = [];
        for (const entry of entries) {
          const message = entry.model?.[0];
          if (message?.role !== "user" && message?.role !== "assistant") continue;
          if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
          if (taintedEntryIds.has(entry.id)) {
            messages.push({ role: message.role, text: REDACTION_TEXT, redacted: true });
            continue;
          }
          const text = messageText(message);
          if (text !== "") messages.push({ role: message.role, text });
        }
        return messages;
      } finally {
        await opened.close();
      }
    });
  }
}
