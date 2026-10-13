import type { Context } from "@earendil-works/chord";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type {
  Conversation,
  ContextView,
  EntryId,
  EntryRecord,
  Harness,
  SubmissionId,
  SubmissionRecord,
  TaskId,
} from "@earendil-works/pi-durable";

/**
 * How `Conversation.compact()` ended. It is a two-step operation in pi-durable 1.1:
 *
 *   1. `compact()` admits a *compaction task* and returns its id. The task selects a cut,
 *      asks the model for a summary, and settles.
 *   2. A settled task that found something to summarize names a *write submission*
 *      (`result.submissionId`) that places the `pi.compaction` entry in the conversation.
 *
 * A task that settled without a `submissionId` found nothing worth cutting.
 */
export type CompactionOutcome =
  | { kind: "nothing_to_compact"; taskId: TaskId }
  | { kind: "placed"; taskId: TaskId; submissionId: SubmissionId; entryId: EntryId }
  | { kind: "not_placed"; taskId: TaskId; submissionId: SubmissionId; placement: SubmissionRecord }
  | { kind: "task_failed"; taskId: TaskId; detail: string };

export async function compactConversation(
  harness: Harness,
  conversation: Conversation,
  instructions: string | undefined,
  context: Context,
): Promise<CompactionOutcome> {
  const taskId = await conversation.compact(instructions, context);
  const settled = await harness.waitForTask(taskId, context);
  const outcome = settled.state.outcome;

  if (outcome.status !== "completed") {
    return { kind: "task_failed", taskId, detail: JSON.stringify(outcome) };
  }
  const submissionId = outcome.result.submissionId;
  if (submissionId === undefined) {
    return { kind: "nothing_to_compact", taskId };
  }

  const placement = await (await harness.submission(submissionId, context))?.wait(context);
  if (placement?.status === "done" && "entry" in placement && placement.entry !== undefined) {
    return { kind: "placed", taskId, submissionId, entryId: placement.entry };
  }
  return { kind: "not_placed", taskId, submissionId, placement: placement as SubmissionRecord };
}

/** Sum of pi-ai's per-message estimate over the messages the model would receive next. */
export function estimatedContextTokens(view: ContextView): number {
  return view.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * `keepRecentTokens` that makes the cut land exactly on the user message that starts the
 * `turns`-th turn from the end. `selectCut` walks back from the tail adding each entry's
 * estimated tokens until the running total reaches `keepRecentTokens`, then cuts at the first
 * candidate at or after that entry — so a budget equal to the last N turns' own estimate stops
 * on N's first entry. A fixed constant would drift with the model's real answer lengths and can
 * land on an assistant message in the middle of a turn instead.
 */
export function keepRecentTokensForLastTurns(view: ContextView, turns: number): number {
  const turnStarts = view.entries.flatMap((entry, index) => (entry.kind === "pi.user" ? [index] : []));
  const from = turnStarts.at(-turns);
  if (from === undefined) {
    throw new Error(`context has ${turnStarts.length} turns; cannot keep the last ${turns}`);
  }
  return view.contributions.slice(from).flat().reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function compactionEntries(entries: readonly EntryRecord[]): EntryRecord[] {
  return entries.filter((entry) => entry.kind === "pi.compaction");
}

/** The text of a `pi.compaction` entry's single user message: the summary inside its wrapper. */
export function compactionSummaryText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message?.role !== "user") {
    throw new Error(`entry ${entry.id} is not a compaction summary`);
  }
  const text = typeof message.content === "string" ? message.content : message.content.map((block) => ("text" in block ? block.text : "")).join("");
  return text;
}

/** Booking numbers (`BK1001`) and container numbers (`MSKU1234567`) mentioned in a piece of text. */
export function extractShipmentIdentifiers(text: string): string[] {
  return [...new Set(text.match(/\b(?:BK\d{4}|[A-Z]{4}\d{7})\b/g) ?? [])].sort();
}
