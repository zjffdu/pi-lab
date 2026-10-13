import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  assertModelAvailable,
  createBookingRuntime,
  GET_BOOKING_TOOL_NAME,
  modelSelectionFromEnvironment,
  UPDATE_BOOKING_STATUS_TOOL_NAME,
} from "../src/create-harness.js";
import { judgeSelectionFromEnvironment } from "../src/semantic-judge.js";

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

  it("rejects the Pi 0.85.1 model id, which does not exist in the 1.1 catalog", () => {
    expect(() => assertModelAvailable(builtinModels(), { provider: "deepseek", modelId: "deepseek-v4-flash" })).toThrow(/Unknown model/);
  });

  it("the semantic judge defaults to the same catalog-valid model and honors PI_JUDGE_* overrides", () => {
    expect(judgeSelectionFromEnvironment({})).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    expect(() => assertModelAvailable(builtinModels(), judgeSelectionFromEnvironment({}))).not.toThrow();
    expect(judgeSelectionFromEnvironment({ PI_JUDGE_PROVIDER: "anthropic", PI_JUDGE_MODEL: "x", PI_MODEL: "y" })).toEqual({
      provider: "anthropic",
      modelId: "x",
    });
  });
});

describe("createBookingRuntime", () => {
  it("exposes each tool's declared replay policy, read from the tool definitions themselves", () => {
    const runtime = createBookingRuntime();
    expect(runtime.toolReplayByName.get(GET_BOOKING_TOOL_NAME)).toBe("safe");
    expect(runtime.toolReplayByName.get(UPDATE_BOOKING_STATUS_TOOL_NAME)).toBe("unsafe");
    expect(runtime.toolReplayByName.size).toBe(2);
  });
});
