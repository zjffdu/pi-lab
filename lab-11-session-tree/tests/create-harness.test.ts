import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { assertModelAvailable, modelSelectionFromEnvironment } from "../src/create-harness.js";

describe("modelSelectionFromEnvironment", () => {
  it("defaults to a model id that exists in the real Pi 1.1 catalog", () => {
    const selection = modelSelectionFromEnvironment({});
    expect(selection).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    // Resolving through the real catalog is what catches a model id that no longer exists in it.
    expect(() => assertModelAvailable(builtinModels(), selection)).not.toThrow();
  });

  it("accepts another registered provider and model", () => {
    expect(modelSelectionFromEnvironment({ PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-6" })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("fails fast with the catalog's real ids for an unknown model", () => {
    expect(() => assertModelAvailable(builtinModels(), { provider: "deepseek", modelId: "deepseek-no-such-model" })).toThrow(
      /Unknown model deepseek\/deepseek-no-such-model/,
    );
  });
});
