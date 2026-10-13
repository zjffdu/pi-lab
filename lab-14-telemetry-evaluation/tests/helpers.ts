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
    super(structuredClone([...BookingRepository.fromDefaultFixture().all()]));
  }

  public override findByBookingNo(bookingNo: string) {
    this.lookups.push(bookingNo);
    return super.findByBookingNo(bookingNo);
  }
}

export async function withTempSessionsRoot<T>(body: (sessionsRoot: string) => Promise<T>): Promise<T> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-14-"));
  try {
    return await body(sessionsRoot);
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
}

/** Plain text of every message in a request, so substring assertions see the real characters
 * (a `JSON.stringify` of the messages would escape the quotes inside a tool result). */
export function plainText(messages: readonly { role: string; content?: unknown }[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .map((block: { type?: string; text?: string; name?: string; arguments?: unknown }) =>
          block.type === "toolCall" ? `${block.name}(${JSON.stringify(block.arguments)})` : (block.text ?? ""),
        )
        .join("");
    })
    .join("\n");
}
