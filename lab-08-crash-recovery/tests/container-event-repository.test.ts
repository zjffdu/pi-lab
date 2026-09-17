import { describe, expect, it } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";

describe("ContainerEventRepository", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();

  it("returns events for a known container, oldest first", () => {
    const events = repository.findByContainerNo("MSKU1234567");
    expect(events.length).toBeGreaterThan(0);
    const timestamps = events.map((event) => event.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it("returns an empty array for an unknown container", () => {
    expect(repository.findByContainerNo("BAD_CONTAINER")).toEqual([]);
  });
});
