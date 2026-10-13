import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { assertModelAvailable, modelSelectionFromEnvironment } from "../src/create-harness.js";

describe("modelSelectionFromEnvironment", () => {
  it("uses the documented DeepSeek Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
  });

  it("accepts another registered provider and model", () => {
    expect(modelSelectionFromEnvironment({ PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-6" })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  // The default id must exist in the real Pi 1.1 catalog. `deepseek-v4-flash` (the 0.85.1 id) does not, and
  // neither tsc nor a test that only checks the default string would notice until something resolves it.
  it("resolves the default through the real Pi 1.1 catalog", () => {
    expect(() => assertModelAvailable(builtinModels(), modelSelectionFromEnvironment({}))).not.toThrow();
  });

  it("fails at startup, naming real catalog ids, for a model the catalog does not have", () => {
    expect(() => assertModelAvailable(builtinModels(), { provider: "deepseek", modelId: "deepseek-v4-flash" })).toThrow(
      /Unknown model deepseek\/deepseek-v4-flash\. Available model ids include: .*deepseek-flash/,
    );
  });
});
