import { describe, expect, it } from "vitest";

import { loadCases } from "../src/case-registry.js";
import { runCase } from "../src/runner.js";
import { Tracer } from "../src/trace.js";
import { renderTraceTree } from "../src/trace-render.js";

describe("renderTraceTree", () => {
  it("nests each span under its parent and prints the stage's attributes", () => {
    const tracer = new Tracer("r");
    const request = tracer.span("request", "receive", null, "ok", { caseId: "c1" });
    const policy = tracer.span("policy", "authorize-read", request.spanId, "ok", { authorized: true });
    tracer.span("tool", "get_booking", policy.spanId, "ok", { bookingNo: "BK1001", found: true });

    expect(renderTraceTree(tracer.all())).toEqual([
      '◀ request/receive status=ok caseId="c1"',
      "  ◀ policy/authorize-read status=ok authorized=true",
      '    ◀ tool/get_booking status=ok bookingNo="BK1001" found=true',
    ]);
  });

  it("marks a denied or errored span with ✕ so the failing boundary stands out", () => {
    const tracer = new Tracer("r");
    const request = tracer.span("request", "receive", null, "ok", {});
    tracer.span("policy", "authorize-read", request.spanId, "denied", { authorized: false });
    expect(renderTraceTree(tracer.all())[1]).toMatch(/^ {2}✕ policy\/authorize-read status=denied/);
  });

  it("shows a span whose parent is missing at the top level as an orphan instead of dropping it", () => {
    const tracer = new Tracer("r");
    tracer.span("approval", "decide", "span-that-was-dropped", "ok", {});
    expect(renderTraceTree(tracer.all())).toEqual(["◀ approval/decide status=ok (orphan)"]);
  });

  it("renders a real pipeline run, including the tool stage's arguments", () => {
    const kase = loadCases("dev").find((entry) => entry.scenario === "read-own-tenant");
    if (!kase) throw new Error("fixture missing");
    const { record } = runCase(kase);
    const lines = renderTraceTree(record.result.spans);
    expect(lines[0]).toMatch(/^◀ request\/receive/);
    expect(lines.some((line) => line.includes('tool/get_booking') && line.includes('bookingNo="BK1001"'))).toBe(true);
  });

  it("never puts a retrieved document's text into telemetry — only that it carried a marker, and its size", () => {
    const kase = loadCases("dev").find((entry) => entry.scenario === "malicious-document");
    if (!kase) throw new Error("fixture missing");
    const { record } = runCase(kase);
    const rendered = renderTraceTree(record.result.spans).join("\n");
    expect(rendered).toContain("containsInjectionMarker=true");
    expect(rendered).not.toContain("SYSTEM OVERRIDE");
  });
});
