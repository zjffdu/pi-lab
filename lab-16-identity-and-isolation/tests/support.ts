import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import type { ModelSelection } from "../src/create-harness.js";

/**
 * A scripted model: nothing in the test suite calls a real provider. `faux.setResponses()` queues one
 * assistant message (or a factory that sees the request's transcript) per model request.
 */
export function createFauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const selection: ModelSelection = { provider: model.provider, modelId: model.id };
  return { faux, models, selection };
}

export async function withTempSessionsRoot<T>(body: (sessionsRoot: string) => Promise<T>): Promise<T> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-16-"));
  try {
    return await body(sessionsRoot);
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
}
