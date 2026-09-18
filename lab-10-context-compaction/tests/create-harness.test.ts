import { describe, expect, it } from "vitest";

import { compactionSettingsFromEnvironment, modelSelectionFromEnvironment } from "../src/create-harness.js";

describe("modelSelectionFromEnvironment", () => {
  it("uses the documented DeepSeek V4 Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it("accepts another registered provider and model", () => {
    expect(
      modelSelectionFromEnvironment({
        PI_PROVIDER: "anthropic",
        PI_MODEL: "claude-sonnet-4-6",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });
});

describe("compactionSettingsFromEnvironment", () => {
  it("defaults to a small, non-default-sized budget so a short seeded conversation actually crosses a cut point", () => {
    const settings = compactionSettingsFromEnvironment({});
    expect(settings).toEqual({ enabled: true, reserveTokens: 300, keepRecentTokens: 180 });
    // Sanity check against the harness's own much larger built-in defaults.
    expect(settings.reserveTokens).toBeLessThan(16384);
    expect(settings.keepRecentTokens).toBeLessThan(20000);
  });

  it("accepts overriding non-negative integers", () => {
    expect(
      compactionSettingsFromEnvironment({ COMPACT_RESERVE_TOKENS: "1000", COMPACT_KEEP_RECENT_TOKENS: "50" }),
    ).toEqual({ enabled: true, reserveTokens: 1000, keepRecentTokens: 50 });
  });

  it("falls back to the default for garbage or negative input", () => {
    expect(compactionSettingsFromEnvironment({ COMPACT_RESERVE_TOKENS: "not-a-number" }).reserveTokens).toBe(300);
    expect(compactionSettingsFromEnvironment({ COMPACT_KEEP_RECENT_TOKENS: "-5" }).keepRecentTokens).toBe(180);
  });
});
