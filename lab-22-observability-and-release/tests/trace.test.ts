import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STAGES, Tracer, latestTraceFor, readTraceFile, tracePathFor } from "../src/trace.js";

describe("Tracer", () => {
  it("records a span in memory with the given stage, status, and attributes", () => {
    const tracer = new Tracer("run-1");
    const span = tracer.span("policy", "authorize-read", null, "denied", { authorized: false });
    expect(span.stage).toBe("policy");
    expect(span.status).toBe("denied");
    expect(span.attributes.authorized).toBe(false);
    expect(tracer.all()).toHaveLength(1);
    expect(tracer.byStage("policy")).toHaveLength(1);
    expect(tracer.byStage("tool")).toHaveLength(0);
  });

  it("links spans to their parent by id", () => {
    const tracer = new Tracer("run-2");
    const request = tracer.span("request", "receive", null, "ok", {});
    const policy = tracer.span("policy", "authorize-read", request.spanId, "ok", {});
    expect(policy.parentSpanId).toBe(request.spanId);
  });

  it("appends every span as one JSON line to that run's own file when a traceDir is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-trace-"));
    const tracer = new Tracer("run-3", dir);
    tracer.span("request", "receive", null, "ok", {});
    tracer.span("policy", "authorize-read", null, "ok", {});

    const path = tracePathFor(dir, "run-3");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readTraceFile(path).map((entry) => entry.stage)).toEqual(["request", "policy"]);
  });

  it("keeps two runs of the same case in separate files instead of mixing their spans", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-trace-"));
    new Tracer("run-case-1", dir).span("request", "receive", null, "ok", {});
    new Tracer("run-case-2", dir).span("request", "receive", null, "ok", {});
    expect(readTraceFile(tracePathFor(dir, "run-case-1"))).toHaveLength(1);
    expect(readTraceFile(tracePathFor(dir, "run-case-2"))).toHaveLength(1);
  });

  it("finds the newest trace for a case id without matching a case whose id merely starts with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-trace-"));
    new Tracer("run-held-read-own-tenant-100", dir).span("request", "receive", null, "ok", {});
    new Tracer("run-held-read-own-tenant-b-200", dir).span("request", "receive", null, "ok", {});
    expect(latestTraceFor(dir, "held-read-own-tenant")).toBe(tracePathFor(dir, "run-held-read-own-tenant-100"));
    expect(latestTraceFor(dir, "no-such-case")).toBeUndefined();
  });

  it("rejects a trace line that is not a span instead of casting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-22-trace-"));
    const path = tracePathFor(dir, "bad");
    writeFileSync(path, '{"hello":"world"}\n');
    expect(() => readTraceFile(path)).toThrow(/not a valid span/);
  });

  it("declares all seven roadmap boundaries", () => {
    expect(STAGES).toEqual(["request", "policy", "approval", "tool", "connector", "retry", "delivery"]);
  });
});
