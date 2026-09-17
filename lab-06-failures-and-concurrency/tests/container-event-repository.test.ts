import { describe, expect, it } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";

describe("ContainerEventRepository", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("returns fixture events for a known container, oldest first", () => {
    const events = repository.findByContainerNo("MSKU1234567");

    expect(events.map((event) => event.eventType)).toEqual(["GATE_IN", "LOAD", "DEPARTURE"]);
    expect(events[0]?.containerNo).toBe("MSKU1234567");
  });

  it("returns an empty array for an unknown container", () => {
    expect(repository.findByContainerNo("UNKNOWN0000")).toEqual([]);
  });
});
