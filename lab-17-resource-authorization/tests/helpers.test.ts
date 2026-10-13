import { describe, expect, it } from "vitest";

import { offeredToolsOf } from "./helpers.js";

/**
 * The helper every "the model was not offered X" assertion relies on. Pi 1.1 requests carry no `tools`
 * field, so if this folded nothing, those assertions would pass vacuously — these tests are what stops that.
 */
const system = (toolsAdded?: string[], toolsRemoved?: string[]) => ({
  role: "system",
  ...(toolsAdded ? { toolsAdded: toolsAdded.map((name) => ({ name })) } : {}),
  ...(toolsRemoved ? { toolsRemoved: toolsRemoved.map((name) => ({ name })) } : {}),
});

describe("offeredToolsOf", () => {
  it("reads the tools a system message adds", () => {
    expect(offeredToolsOf([system(["get_booking", "update_booking_status"]), { role: "user" }])).toEqual(["get_booking", "update_booking_status"]);
  });

  it("applies a later removal", () => {
    expect(offeredToolsOf([system(["get_booking", "update_booking_status"]), { role: "user" }, system(undefined, ["update_booking_status"])])).toEqual(["get_booking"]);
  });

  it("applies a re-addition after a removal, in order", () => {
    expect(offeredToolsOf([system(["a", "b"]), system(undefined, ["b"]), system(["b"])])).toEqual(["a", "b"]);
  });

  it("is empty when no system message declares tools — the case that must never be mistaken for 'nothing offered' by accident", () => {
    expect(offeredToolsOf([{ role: "user" }])).toEqual([]);
  });

  it("ignores tool declarations on non-system messages", () => {
    expect(offeredToolsOf([{ role: "user", toolsAdded: [{ name: "x" }] } as never])).toEqual([]);
  });
});
