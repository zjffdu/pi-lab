import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { AttemptLog } from "../src/attempt-log.js";
import { createReplayRegistry, type ModelSelection, type ReplayRegistryOptions } from "../src/create-harness.js";
import { OutboxRepository } from "../src/outbox-repository.js";

/**
 * A scripted model: nothing in the test suite calls a real provider. `faux.setResponses()` queues
 * one assistant message (or a factory that sees the request's transcript) per model request.
 */
export function createFauxModels(modelIds?: string[]) {
  const faux = fauxProvider(modelIds ? { models: modelIds.map((id) => ({ id })) } : undefined);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const selection: ModelSelection = { provider: model.provider, modelId: model.id };
  return { faux, models, selection };
}

export async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-09-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A replay registry whose attempt log and outbox live under `dir`, never under runtime-evidence/. */
export function createTestRegistry(dir: string, options: ReplayRegistryOptions = {}) {
  const attemptLog = options.attemptLog ?? new AttemptLog(join(dir, "attempts.jsonl"));
  const outbox = options.outbox ?? new OutboxRepository(join(dir, "outbox.jsonl"));
  const registry = createReplayRegistry({
    ...options,
    attemptLog,
    outbox,
    safeTool: { delayMs: 0, onDispatch: () => {}, ...options.safeTool },
    holdTool: { delayMs: 0, onDispatch: () => {}, onEffectAppended: () => {}, ...options.holdTool },
  });
  return { registry, attemptLog, outbox };
}

export const withTempSessionsRoot = withTempDir;
