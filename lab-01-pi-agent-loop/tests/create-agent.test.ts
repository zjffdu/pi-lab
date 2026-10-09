import { describe, expect, it } from "vitest";

import { createBookingAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";

describe("modelSelectionFromEnvironment", () => {
  it("uses the documented DeepSeek Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({
      provider: "deepseek",
      modelId: "deepseek-flash",
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

describe("createBookingAgent", () => {
  // Guards against catalog drift between Pi releases: the default id must resolve in the pinned
  // Pi version's built-in model catalog, otherwise the CLI dies at startup with "Unknown model".
  it("resolves the default model from the pinned Pi catalog", () => {
    const agent = createBookingAgent(modelSelectionFromEnvironment({}));
    expect(agent.state.model.id).toBe("deepseek-flash");
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["get_booking"]);
  });

  it("lists available model ids when the requested model is unknown", () => {
    expect(() => createBookingAgent({ provider: "deepseek", modelId: "no-such-model" })).toThrow(
      /Unknown model deepseek\/no-such-model\. Available model ids include: .*deepseek-flash/,
    );
  });
});
