import { describe, expect, it } from "vitest";

import {
  attemptLogPathFromEnvironment,
  holdToolDelayMsFromEnvironment,
  modelSelectionFromEnvironment,
  outboxPathFromEnvironment,
  safeToolDelayMsFromEnvironment,
} from "../src/create-harness.js";

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

describe("safeToolDelayMsFromEnvironment", () => {
  it("defaults to 8000ms when unset", () => {
    expect(safeToolDelayMsFromEnvironment({})).toBe(8000);
  });

  it("accepts an overriding non-negative integer", () => {
    expect(safeToolDelayMsFromEnvironment({ SAFE_TOOL_DELAY_MS: "250" })).toBe(250);
    expect(safeToolDelayMsFromEnvironment({ SAFE_TOOL_DELAY_MS: "0" })).toBe(0);
  });

  it("falls back to the default for garbage input", () => {
    expect(safeToolDelayMsFromEnvironment({ SAFE_TOOL_DELAY_MS: "not-a-number" })).toBe(8000);
    expect(safeToolDelayMsFromEnvironment({ SAFE_TOOL_DELAY_MS: "-5" })).toBe(8000);
  });
});

describe("holdToolDelayMsFromEnvironment", () => {
  it("defaults to 8000ms when unset", () => {
    expect(holdToolDelayMsFromEnvironment({})).toBe(8000);
  });

  it("accepts an overriding non-negative integer, independent of the safe tool's delay", () => {
    expect(holdToolDelayMsFromEnvironment({ HOLD_TOOL_DELAY_MS: "500", SAFE_TOOL_DELAY_MS: "9999" })).toBe(500);
  });
});

describe("attemptLogPathFromEnvironment / outboxPathFromEnvironment", () => {
  it("default to paths under runtime-evidence/ when unset", () => {
    expect(attemptLogPathFromEnvironment({})).toMatch(/runtime-evidence\/attempts\.jsonl$/);
    expect(outboxPathFromEnvironment({})).toMatch(/runtime-evidence\/outbox\.jsonl$/);
  });

  it("accept an overriding explicit path", () => {
    expect(attemptLogPathFromEnvironment({ ATTEMPT_LOG_PATH: "/tmp/a.jsonl" })).toBe("/tmp/a.jsonl");
    expect(outboxPathFromEnvironment({ OUTBOX_PATH: "/tmp/o.jsonl" })).toBe("/tmp/o.jsonl");
  });
});
