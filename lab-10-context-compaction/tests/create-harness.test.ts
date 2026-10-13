import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  assertModelAvailable,
  compactionPolicyFromEnvironment,
  modelSelectionFromEnvironment,
} from "../src/create-harness.js";

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

describe("compactionPolicyFromEnvironment", () => {
  it("turns every automatic trigger off and uses small budgets, so only a manual compact() runs", () => {
    expect(compactionPolicyFromEnvironment({})).toEqual({
      enabled: false,
      backgroundTokens: 0,
      reserveTokens: 2000,
      keepRecentTokens: 180,
    });
  });

  it("accepts overriding non-negative integers", () => {
    expect(
      compactionPolicyFromEnvironment({ COMPACT_RESERVE_TOKENS: "1000", COMPACT_KEEP_RECENT_TOKENS: "50" }),
    ).toMatchObject({ reserveTokens: 1000, keepRecentTokens: 50 });
  });

  it("falls back to the default for garbage or negative input", () => {
    expect(compactionPolicyFromEnvironment({ COMPACT_RESERVE_TOKENS: "nope" }).reserveTokens).toBe(2000);
    expect(compactionPolicyFromEnvironment({ COMPACT_KEEP_RECENT_TOKENS: "-5" }).keepRecentTokens).toBe(180);
  });
});
