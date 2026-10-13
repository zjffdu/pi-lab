import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { BookingRepository } from "../src/booking-repository.js";
import type { ModelSelection } from "../src/create-harness.js";

/**
 * A scripted model: nothing in the test suite calls a real provider. `faux.setResponses()` queues
 * one assistant message (or a factory that sees the request's transcript) per model request —
 * including the summarization request a compaction makes.
 */
export function createFauxModels(modelIds?: string[]) {
  const faux = fauxProvider(modelIds ? { models: modelIds.map((id) => ({ id })) } : undefined);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const selection: ModelSelection = { provider: model.provider, modelId: model.id };
  return { faux, models, selection };
}

/** Same data as data/bookings.json, plus a record of every lookup the tool actually performed. */
export class SpyBookingRepository extends BookingRepository {
  public readonly lookups: string[] = [];

  public constructor() {
    super(BookingRepository.fromDefaultFixture().all());
  }

  public override findByBookingNo(bookingNo: string) {
    this.lookups.push(bookingNo);
    return super.findByBookingNo(bookingNo);
  }
}

export async function withTempSessionsRoot<T>(body: (sessionsRoot: string) => Promise<T>): Promise<T> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-10-"));
  try {
    return await body(sessionsRoot);
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
}
