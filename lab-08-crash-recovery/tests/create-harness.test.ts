import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  assertModelAvailable,
  modelSelectionFromEnvironment,
  slowToolDelayMsFromEnvironment,
} from "../src/create-harness.js";

describe("modelSelectionFromEnvironment", () => {
  it("uses the documented DeepSeek Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
  });

  it("accepts another registered provider and model", () => {
    expect(
      modelSelectionFromEnvironment({ PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-6" }),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  });
});

describe("assertModelAvailable", () => {
  // Guards against catalog drift between Pi releases: the default id must resolve in the pinned
  // Pi version's built-in model catalog, otherwise the CLI dies at startup with "Unknown model".
  it("resolves the default model from the pinned Pi catalog", () => {
    expect(() => assertModelAvailable(builtinModels(), modelSelectionFromEnvironment({}))).not.toThrow();
  });

  it("lists available model ids when the requested model is unknown", () => {
    expect(() =>
      assertModelAvailable(builtinModels(), { provider: "deepseek", modelId: "no-such-model" }),
    ).toThrow(/Unknown model deepseek\/no-such-model\. Available model ids include: .*deepseek-flash/);
  });

});

describe("slowToolDelayMsFromEnvironment", () => {
  it("defaults to 8000ms when unset", () => {
    expect(slowToolDelayMsFromEnvironment({})).toBe(8000);
  });

  it("accepts an overriding non-negative integer", () => {
    expect(slowToolDelayMsFromEnvironment({ SLOW_TOOL_DELAY_MS: "250" })).toBe(250);
    expect(slowToolDelayMsFromEnvironment({ SLOW_TOOL_DELAY_MS: "0" })).toBe(0);
  });

  it("falls back to the default for garbage input", () => {
    expect(slowToolDelayMsFromEnvironment({ SLOW_TOOL_DELAY_MS: "not-a-number" })).toBe(8000);
    expect(slowToolDelayMsFromEnvironment({ SLOW_TOOL_DELAY_MS: "-5" })).toBe(8000);
  });
});
