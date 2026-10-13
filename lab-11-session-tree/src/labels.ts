import type { Context } from "@earendil-works/chord";
import { defineDoc, type EntryId, type Harness, type Storage } from "@earendil-works/pi-durable";

/**
 * Pi 1.1 has no entry labels. This is application state: one Session-scoped document mapping an entry id
 * (as a string, because JSON object keys are strings) to a name, committed like any other write. It is
 * not part of any transcript, so a label never reaches the model and a fork neither copies nor needs it.
 */
export const Labels = defineDoc<{ labels: Record<string, string> }>({
  kind: "app.labels",
  version: 1,
  scope: "session",
  initial: () => ({ labels: {} }),
});

/** Sets, replaces, or (with `undefined`) clears the label of one entry. Rejects an entry that does not exist. */
export async function setLabel(
  harness: Harness,
  storage: Storage,
  entryId: EntryId,
  label: string | undefined,
  context: Context,
): Promise<void> {
  if ((await storage.entry(entryId, context)) === undefined) {
    throw new Error(`Cannot label unknown entry ${entryId}`);
  }
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Labels);
    if (label === undefined) {
      delete doc.labels[String(entryId)];
    } else {
      doc.labels[String(entryId)] = label;
    }
  }, context);
}

export async function readLabels(harness: Harness, context: Context): Promise<ReadonlyMap<string, string>> {
  const snapshot = await harness.snapshot(Labels, context);
  return new Map(Object.entries(snapshot?.labels ?? {}));
}
