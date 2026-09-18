import { describe, expect, it } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";

describe("ContainerEventRepository", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("returns events for a known container, oldest first", () => {
    const events = repository.findByContainerNo("MSKU1234567");
    expect(events.map((event) => event.eventType)).toEqual(["GATE_IN", "LOAD", "DEPARTURE"]);
  });

  it("returns events for the second container too", () => {
    const events = repository.findByContainerNo("MSKU7654321");
    expect(events.map((event) => event.eventType)).toEqual(["GATE_IN", "LOAD", "DEPARTURE"]);
  });

  it("returns an empty array for an unknown container", () => {
    expect(repository.findByContainerNo("NOSUCH0000000")).toEqual([]);
  });
});
