import type { EntryRecord } from "@earendil-works/pi-durable";

import type { SourceRef } from "./document-repository.js";
import { isSourceRefArray, sameRef } from "./evidence.js";

export const DOC_TOOL_NAMES = ["search_documents", "read_document"] as const;

/** The only parts of a stored entry this module reads: its kind, and the model message it contributes (if any). */
export interface EntryLike {
  id: number | string;
  kind: string;
  message?: { role: string; toolName?: string; details?: unknown; content: unknown; isError?: boolean };
}

/** Pi 1.1 stores one model message per entry in `model`; entries without one (documents, markers) contribute nothing to context. */
export function toEntryLike(entry: Pick<EntryRecord, "id" | "kind" | "model">): EntryLike {
  const message = entry.model?.[0];
  return message === undefined ? { id: entry.id, kind: entry.kind } : { id: entry.id, kind: entry.kind, message: message as NonNullable<EntryLike["message"]> };
}

export type BranchVerdict = "clean" | "revoked" | "unattributable" | "contaminated";

export interface BranchAssessment {
  verdict: BranchVerdict;
  /** Every source that entered this conversation through a document tool, deduplicated. */
  refs: SourceRef[];
  /** Sources in `refs` the caller can no longer read. */
  revoked: SourceRef[];
  /** Document-tool results whose provenance record is missing or malformed. */
  unattributable: Array<number | string>;
  /** Entries whose stored text contains a value that must not leave the process (for example a sensitive field the model echoed). */
  contaminated: Array<number | string>;
  /** Entries whose content depends, directly or by derivation, on a revoked, unattributable, or contaminated entry. */
  taintedEntryIds: Set<number | string>;
}

export function entryText(message: NonNullable<EntryLike["message"]>): string {
  const parts: string[] = [];
  if (typeof message.content === "string") parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const block of message.content as Array<{ type?: string; text?: string; arguments?: unknown }>) {
      if (block.type === "text") parts.push(block.text ?? "");
      else if (block.type === "toolCall") parts.push(JSON.stringify(block.arguments));
    }
  }
  if (message.role === "toolResult" && message.details !== undefined) parts.push(JSON.stringify(message.details));
  return parts.join(" ");
}

/**
 * Rechecks a stored conversation against *current* access. Provenance comes from the `details` the tool
 * wrote on its result message when it produced it (a model cannot set it). Derivation is handled
 * conservatively: once an entry is revoked, unattributable, or contaminated, every later entry that is not
 * the caller's own `pi.user` message is treated as derived from it, because an assistant paraphrase or a
 * summary cannot be traced back to the exact source text. Default-deny: a kind this module does not know
 * is derived. In particular `pi.compaction` carries its summary as a *user-role* message, so the entry
 * kind — not the message role — says who wrote it.
 *
 * Pass the conversation's entries in ascending order. Compaction does not remove the raw entries it
 * summarizes, so scanning the whole history also covers what a summary was built from. The positional
 * rule over-taints across a fork and does not under-taint: everything derived from a revoked result has
 * a later id.
 */
export function assessBranch(
  entries: readonly EntryLike[],
  canRead: (ref: SourceRef) => boolean,
  containsForbidden: (text: string) => boolean = () => false,
): BranchAssessment {
  const refs: SourceRef[] = [];
  const revoked: SourceRef[] = [];
  const unattributable: Array<number | string> = [];
  const contaminated: Array<number | string> = [];
  const taintedEntryIds = new Set<number | string>();
  let tainting = false;

  for (const entry of entries) {
    const message = entry.message;
    const isDocToolResult = message?.role === "toolResult" && (DOC_TOOL_NAMES as readonly string[]).includes(message.toolName ?? "");

    if (message !== undefined && containsForbidden(entryText(message))) {
      contaminated.push(entry.id);
      taintedEntryIds.add(entry.id);
      tainting = true;
    }

    // A failed call (for example an unknown or unreadable ID) returned no document text, so it has no provenance to record.
    if (isDocToolResult && message?.isError !== true) {
      const details = (message?.details ?? undefined) as { sources?: unknown } | undefined;
      if (!isSourceRefArray(details?.sources)) {
        unattributable.push(entry.id);
        tainting = true;
      } else {
        for (const ref of details.sources) {
          if (!refs.some((known) => sameRef(known, ref))) refs.push(ref);
          if (!canRead(ref)) {
            if (!revoked.some((known) => sameRef(known, ref))) revoked.push(ref);
            tainting = true;
          }
        }
      }
    }

    if (tainting && entry.kind !== "pi.user") taintedEntryIds.add(entry.id);
  }

  const verdict: BranchVerdict = unattributable.length > 0 ? "unattributable" : revoked.length > 0 ? "revoked" : contaminated.length > 0 ? "contaminated" : "clean";
  return { verdict, refs, revoked, unattributable, contaminated, taintedEntryIds };
}
