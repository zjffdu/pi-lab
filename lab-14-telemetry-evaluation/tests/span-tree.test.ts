import type { RecordedTelemetrySpan, SpanAttributes } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";

import { byId, childrenIndex, descendantsOf, findByAttribute, findByName, parentOf, renderSpanTree, rootSpans, spanCoverage } from "../src/span-tree.js";

function span(id: number, parentId: number | null, name: string, attributes: SpanAttributes = {}): RecordedTelemetrySpan {
  return { id, parentId, name, attributes, events: [], status: { status: "ok" }, settled: true };
}

const SPANS: RecordedTelemetrySpan[] = [
  span(1, null, "lab.run", { "lab.conversation.id": "run-1" }),
  span(2, 1, "lab.turn", { "lab.turn.number": "turn-1" }),
  span(3, 2, "lab.tool", { "lab.tool.name": "get_booking" }),
  span(4, 2, "lab.tool", { "lab.tool.name": "update_booking_status" }),
  span(5, null, "lab.compaction", {}),
];

describe("span-tree helpers", () => {
  it("rootSpans returns only spans with parentId null", () => {
    expect(rootSpans(SPANS).map((s) => s.id)).toEqual([1, 5]);
  });

  it("childrenIndex groups by parentId", () => {
    const index = childrenIndex(SPANS);
    expect(index.get(1)?.map((s) => s.id)).toEqual([2]);
    expect(index.get(2)?.map((s) => s.id).sort()).toEqual([3, 4]);
    expect(index.get(null)?.map((s) => s.id)).toEqual([1, 5]);
  });

  it("descendantsOf returns the full subtree, not just direct children", () => {
    const descendants = descendantsOf(SPANS, 1).map((s) => s.id).sort();
    expect(descendants).toEqual([2, 3, 4]);
  });

  it("descendantsOf returns an empty array for a leaf span", () => {
    expect(descendantsOf(SPANS, 3)).toEqual([]);
  });

  it("byId supports O(1) lookup", () => {
    const index = byId(SPANS);
    expect(index.get(3)?.name).toBe("lab.tool");
    expect(index.get(999)).toBeUndefined();
  });

  it("findByName filters by exact span name", () => {
    expect(findByName(SPANS, "lab.tool")).toHaveLength(2);
    expect(findByName(SPANS, "lab.navigation")).toHaveLength(0);
  });

  it("findByAttribute filters by exact attribute value", () => {
    expect(findByAttribute(SPANS, "lab.tool.name", "get_booking")).toHaveLength(1);
  });

  it("parentOf returns the parent span object, or undefined for a root", () => {
    const tool = SPANS[2]!;
    expect(parentOf(SPANS, tool)?.id).toBe(2);
    const run = SPANS[0]!;
    expect(parentOf(SPANS, run)).toBeUndefined();
  });

  it("spanCoverage counts spans per name", () => {
    const coverage = spanCoverage(SPANS);
    const byName = new Map(coverage.map((row) => [row.name, row.count]));
    expect(byName.get("lab.tool")).toBe(2);
    expect(byName.get("lab.run")).toBe(1);
  });
});

describe("renderSpanTree", () => {
  it("indents children under their parent and prints only the requested attributes", () => {
    const lines = renderSpanTree(SPANS, { "lab.tool": ["lab.tool.name"] });
    expect(lines).toEqual([
      "lab.run #1",
      "  lab.turn #2",
      '    lab.tool #3 tool.name="get_booking"',
      '    lab.tool #4 tool.name="update_booking_status"',
      "lab.compaction #5",
    ]);
  });

  it("marks an unsettled span with … and an error status with ✗", () => {
    const lines = renderSpanTree([
      { ...span(1, null, "a"), settled: false },
      { ...span(2, 1, "b"), status: { status: "error" } },
    ]);
    expect(lines).toEqual(["a #1 …", "  b #2 ✗"]);
  });

  it("prints a span whose parent is missing from the capture as a root instead of dropping it", () => {
    expect(renderSpanTree([span(7, 99, "orphan")])).toEqual(["orphan #7"]);
  });

  it("omits an attribute the span does not carry", () => {
    expect(renderSpanTree([span(1, null, "a", {})], { a: ["lab.x.missing"] })).toEqual(["a #1"]);
  });
});
