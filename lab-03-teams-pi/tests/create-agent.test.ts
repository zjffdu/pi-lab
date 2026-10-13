import { describe, expect, it } from "vitest";

import { createBookingAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";

describe("modelSelectionFromEnvironment", () => {
  it("uses the documented DeepSeek Flash defaults", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
  });
});

describe("createBookingAgent", () => {
  // Guards against catalog drift between Pi releases: the default id must resolve in the pinned
  // Pi version's built-in model catalog, otherwise every Teams message would fail with a
  // setup_error and the bounded infrastructure answer instead of a real reply.
  it("resolves the default model from the pinned Pi catalog", () => {
    const agent = createBookingAgent(modelSelectionFromEnvironment({}));
    expect(agent.state.model.id).toBe("deepseek-flash");
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["get_booking"]);
  });

  it("lists available model ids when the requested model is unknown", () => {
    expect(() => createBookingAgent({ provider: "deepseek", modelId: "deepseek-v4-flash" })).toThrow(
      /Unknown model deepseek\/deepseek-v4-flash\. Available model ids include: .*deepseek-flash/,
    );
  });
});
