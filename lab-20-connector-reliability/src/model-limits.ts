import { createModels } from "@earendil-works/pi-ai/models";

import type { ModelBinding } from "./create-harness.js";

/**
 * Caps one model response at `maxOutputTokens`.
 *
 * Pi 1.1 has no per-request or per-conversation output limit: `ConversationStreamOptions` carries
 * transport, timeout, retries, headers, metadata, and cache hints, but no `maxTokens`. The cap therefore
 * goes where the provider reads it — the model entry in the `Models` registry — via a Proxy over the
 * provider's `getModels()` on a one-provider registry. A provider then uses `options.maxTokens ??
 * model.maxTokens`. Everything else about the provider (auth, streaming) is the original, called with
 * its own `this`. Pinned in `tests/sdk-assumptions.test.ts`, including against the built-in DeepSeek entry.
 */
export function withOutputCap(binding: ModelBinding, maxOutputTokens: number): ModelBinding {
  const { provider, modelId } = binding.selection;
  const original = binding.models.getProvider(provider);
  if (!original) throw new Error(`Unknown provider ${provider}`);
  const capped = new Proxy(original, {
    get(target, property) {
      if (property === "getModels") {
        return () => target.getModels().map((model) => (model.maxTokens > maxOutputTokens ? { ...model, maxTokens: maxOutputTokens } : model));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const models = createModels();
  models.setProvider(capped);
  if (!models.getModel(provider, modelId)) throw new Error(`Model ${provider}/${modelId} is not in its own provider`);
  return { models, selection: binding.selection };
}
