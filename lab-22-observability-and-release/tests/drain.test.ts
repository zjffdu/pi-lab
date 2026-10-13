import { describe, expect, it } from "vitest";

import { DrainController, DrainInProgressError } from "../src/drain.js";

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("DrainController (the shutdown-while-work-is-active injection)", () => {
  it("waits for in-flight work to finish before drain() resolves", async () => {
    const controller = new DrainController();
    let completed = false;
    const work = controller.track(delay(undefined, 50).then(() => { completed = true; }));
    const draining = controller.drain();
    expect(completed).toBe(false);
    await draining;
    await work;
    expect(completed).toBe(true);
  });

  it("rejects new work started after drain() has begun, rather than silently queuing it", async () => {
    const controller = new DrainController();
    const draining = controller.drain();
    expect(() => controller.track(Promise.resolve())).toThrow(DrainInProgressError);
    await draining;
  });

  it("accepts work started before drain() and tracks it in inFlightCount()", () => {
    const controller = new DrainController();
    expect(controller.inFlightCount()).toBe(0);
    controller.track(delay(undefined, 50));
    expect(controller.inFlightCount()).toBe(1);
    expect(controller.isDraining()).toBe(false);
  });
});
