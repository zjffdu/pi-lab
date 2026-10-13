import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionTask, defineExtension, GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";

import type { SourceRef } from "./document-repository.js";
import { findForbiddenLabels, type ForbiddenValue } from "./egress-scan.js";
import { envelopeRefs, renderSummaryEnvelope } from "./evidence.js";
import type { BranchAssessment } from "./context-provenance.js";

/**
 * What Pi 1.1 puts in front of the model for a compaction summary: a `user`-role message that starts with
 * this text. It is not exported by `pi-durable`, so `tests/sdk-assumptions.test.ts` pins it against a real
 * compaction; if the SDK changes it, that test fails instead of the demotion silently stopping.
 */
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const SUMMARY_SUFFIX = "\n</summary>";
export const WITHHELD = "[withheld by egress guard]";

export type BoundaryViolation =
  | { layer: "request"; kind: "forbidden_content" | "unreadable_source"; label: string; messageIndex: number }
  | { layer: "compaction"; kind: "declined"; label: string };

function escaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Text a scanner should look at in one provider message: text blocks, tool results, tool-call arguments, and tool-result details. */
export function haystacksOf(message: Message): string[] {
  const texts: string[] = [];
  if (typeof message.content === "string") texts.push(message.content);
  else {
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "toolCall") texts.push(JSON.stringify(block.arguments));
    }
  }
  if (message.role === "toolResult" && message.details !== undefined) texts.push(JSON.stringify(message.details));
  return texts;
}

function textOfUser(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  const first = message.content[0];
  return message.content.length === 1 && first?.type === "text" ? first.text : undefined;
}

/**
 * Pi turns a compaction summary into a plain `user` message. A summary is model output derived from
 * documents, so text an injected document smuggled into it would arrive as a user turn. Rebuilt here as an
 * escaped, labeled data envelope.
 */
export function demoteSummary(message: Message): Message {
  const text = textOfUser(message);
  if (text === undefined || !text.startsWith(SUMMARY_PREFIX)) return message;
  const body = text.slice(SUMMARY_PREFIX.length);
  const summary = body.endsWith(SUMMARY_SUFFIX) ? body.slice(0, -SUMMARY_SUFFIX.length) : body;
  return { ...message, content: [{ type: "text", text: renderSummaryEnvelope("compaction", summary) }] };
}

const ENVELOPE_BLOCK = /<external_content source_id="[A-Za-z0-9._-]+" version="\d+"[^>]*>[\s\S]*?<\/external_content>/g;

function mapText(message: Message, change: (text: string) => string): Message {
  if (typeof message.content === "string") return { ...message, content: change(message.content) } as Message;
  const content = message.content.map((block) => {
    if (block.type === "text") return { ...block, text: change(block.text) };
    if (block.type === "toolCall") return JSON.parse(change(JSON.stringify(block))) as typeof block;
    return block;
  });
  return { ...message, content } as Message;
}

export function replaceValues(text: string, forbidden: readonly ForbiddenValue[]): string {
  let out = text;
  for (const item of forbidden) out = out.split(escaped(item.value)).join(WITHHELD).split(item.value).join(WITHHELD);
  return out;
}

export interface MessageGuardOptions {
  forbidden: () => readonly ForbiddenValue[];
  canReadRef: (ref: SourceRef) => boolean;
  onViolation: (violation: BoundaryViolation) => void;
}

/**
 * The transform behind `beforeRequest`, as a pure function: demote summaries, then withhold forbidden values
 * and envelopes naming sources the caller can no longer read. Never throws; reports through `onViolation`.
 */
export function guardMessages(input: readonly Message[], options: MessageGuardOptions): { messages: Message[]; changed: boolean } {
  let changed = false;
  const messages = input.map((original, messageIndex) => {
    let message = demoteSummary(original);
    if (message !== original) changed = true;

    const forbidden = options.forbidden();
    const hits = findForbiddenLabels(haystacksOf(message), forbidden);
    for (const label of hits) options.onViolation({ layer: "request", kind: "forbidden_content", label, messageIndex });
    if (hits.length > 0) {
      message = mapText(message, (text) => replaceValues(text, forbidden));
      changed = true;
    }

    const unreadable = haystacksOf(message).flatMap((text) => envelopeRefs(text)).filter((ref) => !options.canReadRef(ref));
    for (const ref of unreadable) options.onViolation({ layer: "request", kind: "unreadable_source", label: `${ref.sourceId}@${ref.version}`, messageIndex });
    if (unreadable.length > 0) {
      message = mapText(message, (text) => text.replace(ENVELOPE_BLOCK, (block) => (unreadable.some((ref) => block.startsWith(`<external_content source_id="${ref.sourceId}" version="${ref.version}"`)) ? WITHHELD : block)));
      changed = true;
    }
    return message;
  });
  return { messages, changed };
}

export interface EgressGuardOptions {
  /** Evaluated on every request, so an ACL change mid-conversation applies to the very next model call. */
  forbidden: () => readonly ForbiddenValue[];
  canReadRef: (ref: SourceRef) => boolean;
  /**
   * Assessment of the whole conversation, run by `beforeCompact` — an async read, supplied late because the
   * conversation does not exist until the harness is open.
   */
  assessConversation: (context: Context) => Promise<BranchAssessment | undefined>;
  onViolation: (violation: BoundaryViolation) => void;
}

/**
 * Two hooks, and neither ever throws — a throw in a Pi 1.1 hook is reported through `onReport` and the
 * work proceeds anyway (pinned in `tests/sdk-assumptions.test.ts`), so a throw here would only look like a block.
 *
 * - `GenerationTask.beforeRequest` is a **transform and a backstop**. It demotes compaction summaries to
 *   escaped `derived` envelopes, and *withholds*: every forbidden value, and every envelope naming a source the
 *   caller can no longer read, is replaced in that request only, and the violation is recorded so the run can
 *   be reported as failed. The provider still gets a request; it does not get the value. It cannot stop the
 *   request, which is why `ChatService`'s preflight (before `submit()`) and the tools' write-time gate
 *   are the layers that *prevent*.
 * - `CompactionTask.beforeCompact` is the **gate for the summarizer**. A summarization request does not pass
 *   through `beforeRequest` (pinned), so this hook is the only place that can keep session content away from
 *   it. It covers manual, threshold, and overflow-recovery compaction; it `decline`s when the conversation is
 *   not clean or the messages it would summarize contain a forbidden value.
 */
export function createEgressGuard(options: EgressGuardOptions): Extension {
  return defineExtension({
    name: "egress-guard",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => {
          const guarded = guardMessages(request.messages, options);
          return guarded.changed ? { messages: guarded.messages } : undefined;
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, _api, context) => {
          const assessment = await options.assessConversation(context);
          if (assessment === undefined) {
            options.onViolation({ layer: "compaction", kind: "declined", label: "conversation could not be assessed" });
            return { decline: true as const };
          }
          if (assessment.verdict !== "clean") {
            options.onViolation({ layer: "compaction", kind: "declined", label: assessment.verdict });
            return { decline: true as const };
          }
          const forbidden = options.forbidden();
          const labels = findForbiddenLabels(compaction.messages.flatMap(haystacksOf), forbidden);
          if (labels.length > 0) {
            options.onViolation({ layer: "compaction", kind: "declined", label: labels[0] ?? "forbidden_content" });
            return { decline: true as const };
          }
          return undefined;
        },
      }),
    ],
  });
}
