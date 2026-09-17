import { describe, expect, it } from "vitest";

import { modelSelectionFromEnvironment, slowToolDelayMsFromEnvironment } from "../src/create-harness.js";

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
